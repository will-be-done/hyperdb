/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TupleScanOptions, Value } from "../primitives";
import { MIN, MAX } from "../primitives";
import type { WhereClause } from "../primitives";

export const convertWhereToBound = (
  indexCols: string[],
  where: WhereClause[],
): TupleScanOptions[] => {
  const result = where.map((clause) => {
    const { eq, gte, gt, lte, lt } = clause;

    if (
      (eq === undefined || eq?.length === 0) &&
      (gte === undefined || gte?.length === 0) &&
      (gt === undefined || gt?.length === 0) &&
      (lte === undefined || lte?.length === 0) &&
      (lt === undefined || lt?.length === 0)
    ) {
      return {};
    }

    // Check if columns exist in index
    const allConditions = [
      ...(eq || []),
      ...(gte || []),
      ...(gt || []),
      ...(lte || []),
      ...(lt || []),
    ];
    for (const condition of allConditions) {
      if (!indexCols.map(String).includes(condition.col)) {
        throw new Error(`Column '${condition.col}' not found in index`);
      }
    }

    // Group conditions by column
    const conditionsByCol = new Map<
      string,
      {
        eq?: Value;
        gte?: Value;
        gt?: Value;
        lte?: Value;
        lt?: Value;
      }
    >();

    for (const condition of eq || []) {
      const colConditions = conditionsByCol.get(condition.col) || {};
      if (colConditions.eq !== undefined) {
        throw new Error(
          `Multiple equality conditions for column '${condition.col}'`,
        );
      }
      colConditions.eq = condition.val;
      conditionsByCol.set(condition.col, colConditions);
    }

    for (const condition of gte || []) {
      const colConditions = conditionsByCol.get(condition.col) || {};
      colConditions.gte = condition.val;
      conditionsByCol.set(condition.col, colConditions);
    }

    for (const condition of gt || []) {
      const colConditions = conditionsByCol.get(condition.col) || {};
      colConditions.gt = condition.val;
      conditionsByCol.set(condition.col, colConditions);
    }

    for (const condition of lte || []) {
      const colConditions = conditionsByCol.get(condition.col) || {};
      colConditions.lte = condition.val;
      conditionsByCol.set(condition.col, colConditions);
    }

    for (const condition of lt || []) {
      const colConditions = conditionsByCol.get(condition.col) || {};
      colConditions.lt = condition.val;
      conditionsByCol.set(condition.col, colConditions);
    }

    // Check for conflicting conditions (eq cannot coexist with range conditions)
    for (const [col, conditions] of conditionsByCol) {
      if (
        conditions.eq !== undefined &&
        (conditions.gte !== undefined ||
          conditions.gt !== undefined ||
          conditions.lte !== undefined ||
          conditions.lt !== undefined)
      ) {
        throw new Error(`Conflicting conditions for column '${col}'`);
      }
      if (conditions.gt !== undefined && conditions.gte !== undefined) {
        throw new Error(`Both gt and gte for column '${col}'`);
      }
      if (conditions.lt !== undefined && conditions.lte !== undefined) {
        throw new Error(`Both lt and lte for column '${col}'`);
      }
    }

    // Helper function to check if a column has an effective equality condition
    const hasEqualityCondition = (conditions: any) => {
      if (conditions.eq !== undefined) {
        return true;
      }
      // Check if gte and lte have the same value (effective equality)
      if (
        conditions.gte !== undefined &&
        conditions.lte !== undefined &&
        conditions.gte === conditions.lte
      ) {
        return true;
      }
      return false;
    };

    // Find the usable prefix - must be continuous from the start
    let usablePrefix = 0;
    for (let i = 0; i < indexCols.length; i++) {
      const col = String(indexCols[i]);
      const conditions = conditionsByCol.get(col);

      if (!conditions) {
        break; // No condition for this column, stop here
      }

      usablePrefix++;

      // If this is not an equality condition, we cannot use further columns
      if (!hasEqualityCondition(conditions)) {
        break;
      }
    }

    // Check for non-prefix conditions (error case)
    for (const col of conditionsByCol.keys()) {
      const colIndex = indexCols.map(String).indexOf(col);
      if (colIndex >= usablePrefix) {
        throw new Error(
          `Cannot use column '${col}' without specifying eq conditions for all preceding columns`,
        );
      }
    }

    if (usablePrefix === 0) {
      throw new Error("No usable conditions found");
    }

    // Build the tuple bounds
    const result: TupleScanOptions = {};
    const prefixValues: any[] = [];

    // Process equality prefix
    let rangeColumnIndex = -1;
    for (let i = 0; i < usablePrefix; i++) {
      const col = String(indexCols[i]);
      const conditions = conditionsByCol.get(col)!;

      if (conditions.eq !== undefined) {
        prefixValues.push(conditions.eq);
      } else if (
        conditions.gte !== undefined &&
        conditions.lte !== undefined &&
        conditions.gte === conditions.lte
      ) {
        // Effective equality: gte and lte with same value
        prefixValues.push(conditions.gte);
      } else {
        rangeColumnIndex = i;
        break;
      }
    }

    if (rangeColumnIndex === -1) {
      // All conditions are equality - create exact match bounds
      const gteValues = [...prefixValues];
      const lteValues = [...prefixValues];

      // Fill remaining columns with MIN/MAX
      while (gteValues.length < indexCols.length) {
        gteValues.push(MIN);
        lteValues.push(MAX);
      }

      result.gte = gteValues;
      result.lte = lteValues;
    } else {
      // We have a range condition at rangeColumnIndex
      const col = String(indexCols[rangeColumnIndex]);
      const conditions = conditionsByCol.get(col)!;

      const pad = (values: any[], fill: typeof MIN | typeof MAX) => {
        while (values.length < indexCols.length) values.push(fill);
        return values;
      };

      // Exactly one lower and one upper bound: the range column's own bound
      // when given, otherwise the equality prefix's edge.
      if (conditions.gt !== undefined) {
        result.gt = pad([...prefixValues, conditions.gt], MAX);
      } else if (conditions.gte !== undefined) {
        result.gte = pad([...prefixValues, conditions.gte], MIN);
      } else if (prefixValues.length > 0) {
        result.gte = pad([...prefixValues], MIN);
      }

      if (conditions.lt !== undefined) {
        result.lt = pad([...prefixValues, conditions.lt], MIN);
      } else if (conditions.lte !== undefined) {
        result.lte = pad([...prefixValues, conditions.lte], MAX);
      } else if (prefixValues.length > 0) {
        result.lte = pad([...prefixValues], MAX);
      }
    }

    return result;
  });

  return result;
  // return result.map((bounds) =>
  //   normalizeTupleBounds(bounds, index.cols.length),
  // );
};
