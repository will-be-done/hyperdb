/* eslint-disable @typescript-eslint/no-explicit-any */
// NOTE: taken from https://github.com/ccorcos/database-experiments/blob/master/src/lib/InMemoryBinaryPlusTree.ts

// Entries are never changed in place: a write replaces the entry in its
// node's array. A copied node can then share the entries of the node it was
// copied from, and a fork can share them with its base.
export type LeafEntry<K, V> = { readonly key: K; readonly value: V };

export type BranchEntry<K, V> = {
  readonly minKey: K | null;
  readonly child: TreeNode<K, V>;
};

export type BranchNode<K, V = any> = {
  leaf: false;
  children: BranchEntry<K, V>[];
  // The tree allowed to change this node in place. Any other tree copies it.
  owner: object;
};

export type LeafNode<K, V> = {
  leaf: true;
  values: LeafEntry<K, V>[];
  owner: object;
};

export type TreeNode<K, V> = BranchNode<K, V> | LeafNode<K, V>;

function compare(a: any, b: any) {
  if (a === b) return 0;
  if (a > b) return 1;
  return -1;
}

// Both paths run from the leaf up: indexPath[i] is the position of
// nodePath[i] among the children of nodePath[i + 1].
type NodeCursor<K, V> = {
  nodePath: TreeNode<K, V>[];
  indexPath: number[];
};

type IterateArgs<K> = {
  gt?: K;
  gte?: K;
  lt?: K;
  lte?: K;
  limit?: number;
  reverse?: boolean;
};

const iteratorDone: IteratorReturnResult<undefined> = {
  done: true,
  value: undefined,
};

function emptyIterator<T>(): IterableIterator<T> {
  const iterator: IterableIterator<T> = {
    next: () => iteratorDone,
    [Symbol.iterator]: () => iterator,
  };
  return iterator;
}

export class InMemoryBinaryPlusTree<K = any, V = any> {
  root: TreeNode<K, V> | undefined;
  private base?: InMemoryBinaryPlusTree<K, V>;
  private activeFork?: InMemoryBinaryPlusTree<K, V>;
  private owner = {};
  // Nodes a fork created or copied, handed to the base on materialize.
  private forkNodes: TreeNode<K, V>[] = [];
  minSize: number;
  maxSize: number;
  compareKey: (a: K, b: K) => number;

  /**
   * minSize must be an integer from 2 to maxSize / 2 (inclusive). Deletion
   * relies on every non-root node keeping at least two entries, so a node
   * never empties and always has a sibling to merge with.
   */
  constructor(
    minSize: number,
    maxSize: number,
    compareKey: (a: K, b: K) => number = compare,
  ) {
    this.minSize = minSize;
    this.maxSize = maxSize;
    this.compareKey = compareKey;

    if (
      !Number.isInteger(minSize) ||
      !Number.isInteger(maxSize) ||
      minSize < 2 ||
      minSize > maxSize / 2
    ) {
      throw new Error("Invalid tree size.");
    }
  }

  fork(): InMemoryBinaryPlusTree<K, V> {
    if (this.activeFork) {
      throw new Error(
        "Cannot create multiple active forks from the same tree.",
      );
    }

    const forked = new InMemoryBinaryPlusTree<K, V>(
      this.minSize,
      this.maxSize,
      this.compareKey,
    );

    forked.base = this;
    forked.root = this.root;
    this.activeFork = forked;

    return forked;
  }

  materializeFork(): InMemoryBinaryPlusTree<K, V> {
    if (!this.base) return this;
    if (this.activeFork) {
      throw new Error(
        "Cannot materialize a fork while it has an active nested fork.",
      );
    }
    if (this.base.activeFork !== this) {
      throw new Error("Cannot materialize an inactive fork.");
    }

    const base = this.base;
    base.root = this.root;

    for (const node of this.forkNodes) {
      node.owner = base.owner;
      base.trackForkNode(node);
    }
    this.forkNodes = [];
    base.activeFork = undefined;

    return base;
  }

  discardFork(): void {
    if (!this.base) return;
    if (this.activeFork) {
      throw new Error(
        "Cannot discard a fork while it has an active nested fork.",
      );
    }
    if (this.base.activeFork !== this) {
      throw new Error("Cannot discard an inactive fork.");
    }

    this.base.activeFork = undefined;
  }

  private trackForkNode(node: TreeNode<K, V>) {
    if (this.base) this.forkNodes.push(node);
  }

  private newLeaf(values: LeafEntry<K, V>[]): LeafNode<K, V> {
    const node: LeafNode<K, V> = { leaf: true, values, owner: this.owner };
    this.trackForkNode(node);
    return node;
  }

  private newBranch(children: BranchEntry<K, V>[]): BranchNode<K, V> {
    const node: BranchNode<K, V> = { leaf: false, children, owner: this.owner };
    this.trackForkNode(node);
    return node;
  }

  private cloneNode(node: TreeNode<K, V>): TreeNode<K, V> {
    return node.leaf === true
      ? this.newLeaf(node.values.slice())
      : this.newBranch(node.children.slice());
  }

  private writableRoot(): TreeNode<K, V> | undefined {
    const root = this.root;
    if (!root || root.owner === this.owner) return root;

    this.root = this.cloneNode(root);
    return this.root;
  }

  private writableChild(parent: BranchNode<K, V>, childIndex: number) {
    const entry = parent.children[childIndex];
    if (entry.child.owner === this.owner) return entry.child;

    const cloned = this.cloneNode(entry.child);
    parent.children[childIndex] = { minKey: entry.minKey, child: cloned };
    return cloned;
  }

  private setMinKey(
    parent: BranchNode<K, V>,
    childIndex: number,
    minKey: K | null,
  ) {
    const entry = parent.children[childIndex];
    parent.children[childIndex] = { minKey, child: entry.child };
  }

  private compareBranchKey = (a: K | null, b: K | null) => {
    if (a === null || b === null) {
      if (a === null) return -1;
      if (b === null) return 1;
    }
    return this.compareKey(a, b);
  };

  private searchBranchChild(children: BranchEntry<K, V>[], key: K) {
    let left = 0;
    let right = children.length;

    while (left < right) {
      const mid = (left + right) >>> 1;
      const minKey = children[mid].minKey;
      const cmp = minKey === null ? -1 : this.compareKey(minKey, key);

      if (cmp === 0) return mid;
      if (cmp < 0) left = mid + 1;
      else right = mid;
    }

    if (left === 0) throw new Error("Broken.");
    return left - 1;
  }

  // Unlike NodeCursor, this path runs from the root down.
  private findPathFromRoot(key: K, writable = false): NodeCursor<K, V> {
    const nodePath: TreeNode<K, V>[] = [];
    const indexPath: number[] = [];

    let node = writable ? this.writableRoot() : this.root;
    if (!node) return { nodePath, indexPath };
    nodePath.push(node);

    while (node.leaf !== true) {
      const childIndex: number = this.searchBranchChild(node.children, key);
      node = writable
        ? this.writableChild(node, childIndex)
        : node.children[childIndex].child;
      nodePath.push(node);
      indexPath.push(childIndex);
    }

    return { nodePath, indexPath };
  }

  private findPath(key: K, writable = false): NodeCursor<K, V> {
    const cursor = this.findPathFromRoot(key, writable);
    cursor.nodePath.reverse();
    cursor.indexPath.reverse();
    return cursor;
  }

  get(key: K): V | undefined {
    let node = this.root;
    if (!node) return;

    while (node.leaf !== true) {
      node = node.children[this.searchBranchChild(node.children, key)].child;
    }

    const index = this.searchLeafValueIndex(node.values, key);
    if (index < 0) return;
    return node.values[index].value;
  }

  private edgeCursor(last: boolean): NodeCursor<K, V> {
    const nodePath: TreeNode<K, V>[] = [];
    const indexPath: number[] = [];

    let node = this.root;
    if (!node) return { nodePath, indexPath };
    nodePath.push(node);

    while (node.leaf !== true) {
      const childIndex: number = last ? node.children.length - 1 : 0;
      node = node.children[childIndex].child;
      nodePath.push(node);
      indexPath.push(childIndex);
    }

    nodePath.reverse();
    indexPath.reverse();
    return { nodePath, indexPath };
  }

  // Moves the cursor to the next (or previous) leaf in place. Returns false,
  // leaving the cursor unchanged, when it is already on the last leaf.
  private stepCursor(cursor: NodeCursor<K, V>, reverse: boolean): boolean {
    const { nodePath, indexPath } = cursor;

    for (let i = 0; i < nodePath.length - 1; i++) {
      // Find the point in the path where we need to go down a sibling branch.
      const parent = nodePath[i + 1] as BranchNode<K, V>;
      const siblingIndex = indexPath[i] + (reverse ? -1 : 1);
      if (siblingIndex < 0 || siblingIndex >= parent.children.length) continue;

      // Here's a branch.
      indexPath[i] = siblingIndex;

      // Fix the rest of the cursor.
      for (let j = i; j >= 0; j--) {
        const child = (nodePath[j + 1] as BranchNode<K, V>).children[
          indexPath[j]
        ].child;
        nodePath[j] = child;
        if (j > 0) {
          indexPath[j - 1] = reverse
            ? (child.leaf === true
                ? child.values.length
                : child.children.length) - 1
            : 0;
        }
      }
      return true;
    }

    return false;
  }

  private validateIterateArgs(args: IterateArgs<K>) {
    if (args.gt !== undefined && args.gte !== undefined)
      throw new Error("Invalid bounds: {gt, gte}");
    if (args.lt !== undefined && args.lte !== undefined)
      throw new Error("Invalid bounds: {lt, lte}");

    const start =
      args.gt !== undefined
        ? args.gt
        : args.gte !== undefined
          ? args.gte
          : undefined;
    const startOpen = args.gt !== undefined;
    const end =
      args.lt !== undefined
        ? args.lt
        : args.lte !== undefined
          ? args.lte
          : undefined;
    const endOpen = args.lt !== undefined;

    if (start !== undefined && end !== undefined) {
      const comp = this.compareKey(start, end);
      if (comp > 0) {
        console.warn("Invalid bounds.", args);
        throw new Error("Invalid bounds.");
      }
      if (comp === 0 && (startOpen || endOpen)) {
        console.warn("Invalid bounds.", args);
        throw new Error("Invalid bounds.");
      }
    }

    return { start, startOpen, end, endOpen };
  }

  /**
   * Iterates entries in key order within the bounds. The cursor is placed
   * when this is called, so writes made to the tree while iterating are not
   * supported.
   */
  iterate(args: IterateArgs<K> = {}): IterableIterator<LeafEntry<K, V>> {
    let remaining = args.limit ?? Infinity;
    if (remaining <= 0) return emptyIterator();

    const { start, startOpen, end, endOpen } = this.validateIterateArgs(args);
    const reverse = args.reverse === true;
    const compareKey = this.compareKey;

    const from = reverse ? end : start;
    const cursor =
      from !== undefined ? this.findPath(from) : this.edgeCursor(reverse);
    let leaf = cursor.nodePath[0] as LeafNode<K, V> | undefined;
    let index = 0;

    if (leaf) {
      if (reverse) {
        index = leaf.values.length - 1;
        if (end !== undefined) {
          const result = this.searchLeafValues(leaf.values, end);
          index =
            result.found !== undefined
              ? endOpen
                ? result.found - 1
                : result.found
              : result.closest - 1;
        }
      } else if (start !== undefined) {
        const result = this.searchLeafValues(leaf.values, start);
        index =
          result.found !== undefined
            ? startOpen
              ? result.found + 1
              : result.found
            : result.closest;
      }
    }

    const next = (): IteratorResult<LeafEntry<K, V>, undefined> => {
      while (leaf !== undefined) {
        const values: LeafEntry<K, V>[] = leaf.values;

        if (reverse ? index < 0 : index >= values.length) {
          if (!this.stepCursor(cursor, reverse)) {
            leaf = undefined;
            break;
          }
          leaf = cursor.nodePath[0] as LeafNode<K, V>;
          index = reverse ? leaf.values.length - 1 : 0;
          continue;
        }

        const item = values[index];
        index += reverse ? -1 : 1;

        if (reverse) {
          if (start !== undefined) {
            const comp = compareKey(item.key, start);
            if (comp < 0 || (comp === 0 && startOpen)) break;
          }
        } else if (end !== undefined) {
          const comp = compareKey(item.key, end);
          if (comp > 0 || (comp === 0 && endOpen)) break;
        }

        if (--remaining <= 0) leaf = undefined;
        return { done: false, value: item };
      }

      leaf = undefined;
      return iteratorDone;
    };

    const iterator: IterableIterator<LeafEntry<K, V>> = {
      next,
      [Symbol.iterator]: () => iterator,
    };
    return iterator;
  }

  list(args: IterateArgs<K> = {}): LeafEntry<K, V>[] {
    const result: LeafEntry<K, V>[] = [];
    const iterator = this.iterate(args);
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      result.push(step.value);
    }
    return result;
  }

  /** Same as list(args), but returns only the values. */
  values(args: IterateArgs<K> = {}): V[] {
    const result: V[] = [];
    const iterator = this.iterate(args);
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      result.push(step.value.value);
    }
    return result;
  }

  set(key: K, value: V) {
    const { nodePath, indexPath } = this.findPathFromRoot(key, true);

    // Intitalize root node.
    if (nodePath.length === 0) {
      this.root = this.newLeaf([{ key, value }]);
      return;
    }

    // Insert into leaf node.
    const leaf = nodePath[nodePath.length - 1] as LeafNode<K, V>;
    const existing = this.insertLeafValue(leaf.values, { key, value });
    // No need to rebalance if we're replacing an existing item.
    if (existing) return;

    // Balance the tree by splitting nodes, starting from the leaf.
    let node = nodePath.pop();
    while (node) {
      const size =
        node.leaf === true ? node.values.length : node.children.length;
      if (size <= this.maxSize) break;
      const splitIndex = Math.round(size / 2);

      // NOTE: splice mutates the node, which keeps the left half.
      let rightNode: TreeNode<K, V>;
      let rightMinKey: K | null;
      if (node.leaf === true) {
        const rightLeaf = this.newLeaf(node.values.splice(splitIndex));
        rightMinKey = rightLeaf.values[0].key;
        rightNode = rightLeaf;
      } else {
        const rightBranch = this.newBranch(node.children.splice(splitIndex));
        rightMinKey = rightBranch.children[0].minKey;
        rightNode = rightBranch;
      }

      if (node === this.root) {
        this.root = this.newBranch([
          { minKey: null, child: node },
          { minKey: rightMinKey, child: rightNode },
        ]);
        break;
      }

      // Insert right node into parent.
      const parent = nodePath.pop() as BranchNode<K, V>;
      const parentIndex = indexPath.pop();
      if (!parent) throw new Error("Broken.");
      if (parentIndex === undefined) throw new Error("Broken.");
      parent.children.splice(parentIndex + 1, 0, {
        minKey: rightMinKey,
        child: rightNode,
      });

      // Recur
      node = parent;
    }
  }

  delete(key: K) {
    const { nodePath, indexPath } = this.findPath(key, true);
    if (nodePath.length === 0) return;

    const leaf = nodePath[0] as LeafNode<K, V>;
    const removeIndex = this.searchLeafValueIndex(leaf.values, key);
    if (removeIndex < 0) return; // No changes to the tree!
    leaf.values.splice(removeIndex, 1);

    // Merge or redistribute to maintain minSize.
    let node = nodePath.shift();
    while (node) {
      if (node === this.root) {
        // A root leaf node has no minSize constaint.
        if (node.leaf === true) return;

        // Cleanup an empty root node.
        if (node.children.length === 0) {
          this.root = undefined;
          return;
        }

        // A root node with one child becomes its child.
        if (node.children.length === 1) {
          this.root = node.children[0].child;
        }

        return;
      }

      const parent = nodePath.shift() as BranchNode<K, V>;
      const parentIndex = indexPath.shift();
      if (!parent) throw new Error("Broken.");
      if (parentIndex === undefined) throw new Error("Broken.");

      const size =
        node.leaf === true ? node.values.length : node.children.length;

      // No need to merge but we might need to update the minKey in the parent
      if (size >= this.minSize) {
        // minSize >= 2, so the node is not empty here.
        const minKey =
          node.leaf === true ? node.values[0].key : node.children[0].minKey;
        const parentItem = parent.children[parentIndex];
        // No need to recusively update the left-most branch.
        if (parentItem.minKey === null) return;
        // No need to recursively update if the minKey didn't change.
        if (this.compareBranchKey(parentItem.minKey, minKey) === 0) return;
        // Set the minKey and recur
        this.setMinKey(parent, parentIndex, minKey);
        node = parent;
        continue;
      }

      // Merge or redistribute leaf nodes.
      if (node.leaf === true) {
        if (parentIndex === 0) {
          const rightSibling = parent.children[parentIndex + 1]
            .child as LeafNode<K, V>;
          const combinedSize = node.values.length + rightSibling.values.length;

          // Redistribute leaf.
          if (combinedSize > this.maxSize) {
            const writableRightSibling = this.writableChild(
              parent,
              parentIndex + 1,
            ) as LeafNode<K, V>;
            const splitIndex =
              Math.round(combinedSize / 2) - node.values.length;
            // NOTE: this mutates the array!
            const moveLeft = writableRightSibling.values.splice(0, splitIndex);
            node.values.push(...moveLeft);
            // Update parent minKey.
            if (parent.children[parentIndex].minKey !== null) {
              this.setMinKey(parent, parentIndex, node.values[0].key);
            }
            this.setMinKey(
              parent,
              parentIndex + 1,
              writableRightSibling.values[0].key,
            );

            // Recur
            node = parent;
            continue;
          }

          // Merge leaves.
          node.values.push(...rightSibling.values);
          // Delete rightSibling
          parent.children.splice(1, 1);
          // Update parent minKey
          const leftMost = parent.children[0].minKey === null;
          this.setMinKey(parent, 0, leftMost ? null : node.values[0].key);

          // Recur
          node = parent;
          continue;
        }

        const leftSibling = parent.children[parentIndex - 1].child as LeafNode<
          K,
          V
        >;
        const combinedSize = leftSibling.values.length + node.values.length;

        // Redistribute leaf.
        if (combinedSize > this.maxSize) {
          const writableLeftSibling = this.writableChild(
            parent,
            parentIndex - 1,
          ) as LeafNode<K, V>;
          const splitIndex = Math.round(combinedSize / 2);

          const moveRight = writableLeftSibling.values.splice(
            splitIndex,
            this.maxSize,
          );
          node.values.unshift(...moveRight);

          // Update parent minKey.
          this.setMinKey(parent, parentIndex, node.values[0].key);

          // Recur
          node = parent;
          continue;
        }

        // Merge leaf.
        const writableLeftSibling = this.writableChild(
          parent,
          parentIndex - 1,
        ) as LeafNode<K, V>;
        writableLeftSibling.values.push(...node.values);
        // Delete the node
        parent.children.splice(parentIndex, 1);
        // No need to update minKey because we added to the right.

        // Recur
        node = parent;
        continue;
      }

      // Merge or redistribute branch nodes.
      if (parentIndex === 0) {
        const rightSibling = parent.children[parentIndex + 1]
          .child as BranchNode<K, V>;
        const combinedSize =
          node.children.length + rightSibling.children.length;

        // Redistribute leaf.
        if (combinedSize > this.maxSize) {
          const writableRightSibling = this.writableChild(
            parent,
            parentIndex + 1,
          ) as BranchNode<K, V>;
          const splitIndex =
            Math.round(combinedSize / 2) - node.children.length;
          // NOTE: this mutates the array!
          const moveLeft = writableRightSibling.children.splice(0, splitIndex);
          node.children.push(...moveLeft);
          // Update parent minKey.
          if (parent.children[parentIndex].minKey !== null) {
            this.setMinKey(parent, parentIndex, node.children[0].minKey);
          }
          this.setMinKey(
            parent,
            parentIndex + 1,
            writableRightSibling.children[0].minKey,
          );

          // Recur
          node = parent;
          continue;
        }

        // Merge leaves.
        node.children.push(...rightSibling.children);
        // Delete rightSibling
        parent.children.splice(1, 1);
        // Update parent minKey
        const leftMost = parent.children[0].minKey === null;
        this.setMinKey(parent, 0, leftMost ? null : node.children[0].minKey);

        // Recur
        node = parent;
        continue;
      }

      const leftSibling = parent.children[parentIndex - 1].child as BranchNode<
        K,
        V
      >;
      const combinedSize = leftSibling.children.length + node.children.length;

      // Redistribute leaf.
      if (combinedSize > this.maxSize) {
        const writableLeftSibling = this.writableChild(
          parent,
          parentIndex - 1,
        ) as BranchNode<K, V>;
        const splitIndex = Math.round(combinedSize / 2);

        const moveRight = writableLeftSibling.children.splice(
          splitIndex,
          this.maxSize,
        );
        node.children.unshift(...moveRight);

        // Update parent minKey.
        this.setMinKey(parent, parentIndex, node.children[0].minKey);

        // Recur
        node = parent;
        continue;
      }

      // Merge leaf.
      const writableLeftSibling = this.writableChild(
        parent,
        parentIndex - 1,
      ) as BranchNode<K, V>;
      writableLeftSibling.children.push(...node.children);
      // Delete the node
      parent.children.splice(parentIndex, 1);
      // No need to update minKey because we added to the right.

      // Recur
      node = parent;
      continue;
    }
  }

  private searchLeafValues(values: LeafEntry<K, V>[], searchKey: K) {
    const index = this.searchLeafValueIndex(values, searchKey);
    if (index >= 0) return { found: index, closest: index };
    return { closest: ~index };
  }

  private searchLeafValueIndex(values: LeafEntry<K, V>[], searchKey: K) {
    let left = 0;
    let right = values.length;

    while (left < right) {
      const mid = (left + right) >>> 1; // Fast integer division
      const cmp = this.compareKey(values[mid].key, searchKey);

      if (cmp === 0) return mid;
      if (cmp < 0) left = mid + 1;
      else right = mid;
    }

    return ~left;
  }

  private insertLeafValue(values: LeafEntry<K, V>[], item: LeafEntry<K, V>) {
    const index = this.searchLeafValueIndex(values, item.key);

    if (index >= 0) {
      // Replace existing
      const oldItem = values[index];
      values[index] = item;
      return oldItem;
    } else {
      // Insert new
      values.splice(~index, 0, item);
      return undefined;
    }
  }
}
