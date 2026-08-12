class CompatibilityChecker {
  /**
   * Normalize a UDT FIELD type for comparison: strip `frozen<...>` wrappers
   * around known UDT names, anywhere in the type string.
   *
   * Everything nested inside a UDT is implicitly frozen — Cassandra only
   * permits non-frozen UDTs as top-level column types — so `mapbounds` and
   * `frozen<mapbounds>` describe the SAME field. Which spelling
   * system_schema reports depends on how the type was originally DECLARED
   * (a legacy CREATE TYPE without the frozen keyword reads back bare; one
   * created from a frozen<> declaration reads back wrapped), so a literal
   * string comparison manufactures incompatibilities between semantically
   * identical schemas — and there is no ALTER that could ever "fix" them.
   *
   * Deliberately applied ONLY to UDT fields: on table COLUMNS, frozen vs
   * non-frozen UDT is a real semantic difference and stays strict.
   *
   * @param {string} type - The field type string.
   * @param {Set<string>} udtNames - Known UDT names (app + live).
   * @returns {string}
   */
  normalizeUdtFieldType(type, udtNames) {
    let out = String(type);
    let prev;
    do {
      prev = out;
      for (const name of udtNames) {
        out = out.split(`frozen<${name}>`).join(name);
      }
    } while (out !== prev);
    return out;
  }

  /**
   * Check if the live database schema can support the application schema.
   * Returns an array of incompatibility error messages.
   * Empty array means fully compatible.
   *
   * @param {object} liveSchema - The normalized schema from the live database.
   * @param {object} appSchema - The normalized schema expected by the application.
   * @returns {string[]} Array of error messages.
   */
  check(liveSchema, appSchema) {
    const errors = [];
    const ks = appSchema.keyspace;

    if (liveSchema.keyspace !== appSchema.keyspace) {
      errors.push(`Keyspace mismatch: expected "${appSchema.keyspace}", but connected to "${liveSchema.keyspace}"`);
      return errors; // Fatal, cannot check further
    }

    // 1. Check UDTs
    const liveTypes = liveSchema.types || {};
    const appTypes = appSchema.types || {};
    const udtNames = new Set([...Object.keys(appTypes), ...Object.keys(liveTypes)]);

    for (const [typeName, appTypeDef] of Object.entries(appTypes)) {
      if (!(typeName in liveTypes)) {
        errors.push(`Missing UDT: ${ks}.${typeName}`);
        continue;
      }

      const liveTypeDef = liveTypes[typeName];
      for (const [fieldName, fieldType] of Object.entries(appTypeDef.fields)) {
        if (!(fieldName in liveTypeDef.fields)) {
          errors.push(`Missing UDT field: ${ks}.${typeName}.${fieldName}`);
        } else if (
          this.normalizeUdtFieldType(liveTypeDef.fields[fieldName], udtNames) !==
          this.normalizeUdtFieldType(fieldType, udtNames)
        ) {
          errors.push(`Type mismatch in UDT ${ks}.${typeName} field "${fieldName}": app expects ${fieldType}, but live has ${liveTypeDef.fields[fieldName]}`);
        }
      }
    }

    // 2. Check Tables
    const liveTables = liveSchema.tables || {};
    const appTables = appSchema.tables || {};

    for (const [tableName, appTableDef] of Object.entries(appTables)) {
      if (!(tableName in liveTables)) {
        errors.push(`Missing table: ${ks}.${tableName}`);
        continue;
      }

      const liveTableDef = liveTables[tableName];

      // Check Primary Key match
      // Note: we stringify to easily compare nested arrays/objects like clustering keys
      const appPK = JSON.stringify([appTableDef.partition_key, appTableDef.clustering_key]);
      const livePK = JSON.stringify([liveTableDef.partition_key, liveTableDef.clustering_key]);
      if (appPK !== livePK) {
        errors.push(`Primary key mismatch for table ${ks}.${tableName}: app expects ${appPK}, but live has ${livePK}`);
      }

      // Check Columns
      for (const [colName, appColDef] of Object.entries(appTableDef.columns)) {
        if (!(colName in liveTableDef.columns)) {
          errors.push(`Missing column: ${ks}.${tableName}.${colName}`);
        } else {
          const liveColDef = liveTableDef.columns[colName];
          if (appColDef.type !== liveColDef.type) {
            errors.push(`Type mismatch in column ${ks}.${tableName}.${colName}: app expects ${appColDef.type}, but live has ${liveColDef.type}`);
          }
          if (!!appColDef.static !== !!liveColDef.static) {
            errors.push(`Static mismatch in column ${ks}.${tableName}.${colName}: app expects static=${!!appColDef.static}, but live has static=${!!liveColDef.static}`);
          }
        }
      }

      // Check Indexes
      // We check that the live DB has an index on the columns the app expects to be indexed.
      const liveIndexes = (liveTableDef.indexes || []).map(idx => typeof idx === 'string' ? idx : idx.column);
      const appIndexes = (appTableDef.indexes || []).map(idx => typeof idx === 'string' ? idx : idx.column);

      for (const idxCol of appIndexes) {
        if (!liveIndexes.includes(idxCol)) {
          errors.push(`Missing index on column: ${ks}.${tableName}.${idxCol}`);
        }
      }
    }

    return errors;
  }
}

module.exports = { CompatibilityChecker };
