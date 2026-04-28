/**
 * MigrationDiffer — compares two normalized schema objects and produces
 * migration CQL statements to move from `old` to `new`.
 *
 * Supports:
 *   - Add/drop tables
 *   - Add/drop columns (ALTER TABLE)
 *   - Change table options
 *   - Add/drop indexes
 *   - Add/drop UDTs + add UDT fields
 *   - Replication changes
 *
 * Does NOT support (by design — Cassandra doesn't either):
 *   - Renaming columns (except clustering key rename)
 *   - Changing column types (except widening, e.g. int → bigint)
 *   - Dropping primary key columns
 *   - Changing primary key composition
 */

class MigrationDiffer {
  /**
   * @param {object} oldSchema — normalized schema (from SchemaRegistry)
   * @param {object} newSchema — normalized schema (from SchemaRegistry)
   * @returns {{ statements: string[], warnings: string[], breaking: string[] }}
   */
  diff(oldSchema, newSchema) {
    if (oldSchema.keyspace !== newSchema.keyspace) {
      throw new Error(
        `Cannot diff schemas with different keyspaces: "${oldSchema.keyspace}" vs "${newSchema.keyspace}"`
      );
    }

    const ks = oldSchema.keyspace;
    const statements = [];
    const warnings = [];
    const breaking = [];

    // ── Replication changes ──
    this._diffReplication(ks, oldSchema, newSchema, statements, warnings);

    // ── UDT changes ──
    this._diffTypes(ks, oldSchema.types || {}, newSchema.types || {}, statements, warnings, breaking);

    // ── Table changes ──
    const oldTables = Object.keys(oldSchema.tables);
    const newTables = Object.keys(newSchema.tables);

    // New tables
    for (const t of newTables) {
      if (!oldTables.includes(t)) {
        statements.push(...this._createTable(ks, t, newSchema.tables[t]));
      }
    }

    // Dropped tables
    for (const t of oldTables) {
      if (!newTables.includes(t)) {
        statements.push(`DROP TABLE IF EXISTS ${ks}.${t};`);
        breaking.push(`Dropping table ${ks}.${t}`);
      }
    }

    // Modified tables
    for (const t of newTables) {
      if (oldTables.includes(t)) {
        this._diffTable(ks, t, oldSchema.tables[t], newSchema.tables[t], statements, warnings, breaking);
      }
    }

    return { statements, warnings, breaking };
  }

  // ── Replication ──

  _diffReplication(ks, oldSchema, newSchema, statements, warnings) {
    const oldRep = JSON.stringify(oldSchema.replication);
    const newRep = JSON.stringify(newSchema.replication);
    if (oldRep !== newRep) {
      const rep = newSchema.replication;
      let repStr;
      if (rep.class === 'SimpleStrategy') {
        repStr = `{'class': 'SimpleStrategy', 'replication_factor': ${rep.replication_factor || 1}}`;
      } else {
        const parts = [`'class': 'NetworkTopologyStrategy'`];
        for (const [key, val] of Object.entries(rep)) {
          if (key === 'class') continue;
          parts.push(`'${key}': ${val}`);
        }
        repStr = `{${parts.join(', ')}}`;
      }
      statements.push(`ALTER KEYSPACE ${ks} WITH replication = ${repStr};`);
      warnings.push(`Replication strategy changed for keyspace ${ks}. Requires nodetool repair.`);
    }
  }

  // ── UDTs ──

  _diffTypes(ks, oldTypes, newTypes, statements, warnings, breaking) {
    const oldNames = Object.keys(oldTypes);
    const newNames = Object.keys(newTypes);

    for (const name of newNames) {
      if (!oldNames.includes(name)) {
        const fields = Object.entries(newTypes[name].fields)
          .map(([f, t]) => `  ${f} ${t}`)
          .join(',\n');
        statements.push(`CREATE TYPE IF NOT EXISTS ${ks}.${name} (\n${fields}\n);`);
      }
    }

    for (const name of oldNames) {
      if (!newNames.includes(name)) {
        statements.push(`DROP TYPE IF EXISTS ${ks}.${name};`);
        breaking.push(`Dropping UDT ${ks}.${name}`);
      }
    }

    // Field additions in existing types
    for (const name of newNames) {
      if (!oldNames.includes(name)) continue;
      const oldFields = oldTypes[name].fields;
      const newFields = newTypes[name].fields;

      for (const [field, type] of Object.entries(newFields)) {
        if (!(field in oldFields)) {
          statements.push(`ALTER TYPE ${ks}.${name} ADD ${field} ${type};`);
        } else if (oldFields[field] !== type) {
          warnings.push(`UDT ${ks}.${name} field "${field}" type changed from ${oldFields[field]} to ${type}. Cassandra may not support this.`);
        }
      }

      for (const field of Object.keys(oldFields)) {
        if (!(field in newFields)) {
          warnings.push(`UDT ${ks}.${name} field "${field}" removed in new schema. Cassandra does not support dropping UDT fields.`);
        }
      }
    }
  }

  // ── Tables ──

  _diffTable(ks, tableName, oldDef, newDef, statements, warnings, breaking) {
    // Primary key changes are not supported
    const oldPK = JSON.stringify([oldDef.partition_key, oldDef.clustering_key]);
    const newPK = JSON.stringify([newDef.partition_key, newDef.clustering_key]);
    if (oldPK !== newPK) {
      warnings.push(
        `Table ${ks}.${tableName}: Primary key changed. Cassandra does not support ALTER PRIMARY KEY. ` +
        `You must drop and recreate the table (data loss!).`
      );
      breaking.push(`Primary key change on ${ks}.${tableName} requires recreate`);
    }

    // Column additions
    for (const [col, colDef] of Object.entries(newDef.columns)) {
      if (!(col in oldDef.columns)) {
        const type = colDef.type;
        const isStatic = colDef.static ? ' STATIC' : '';
        statements.push(`ALTER TABLE ${ks}.${tableName} ADD ${col} ${type}${isStatic};`);
      }
    }

    // Column removals
    for (const col of Object.keys(oldDef.columns)) {
      if (!(col in newDef.columns)) {
        const pk = [...oldDef.partition_key, ...(oldDef.clustering_key || []).map(c => c.column)];
        if (pk.includes(col)) {
          warnings.push(`Table ${ks}.${tableName}: Cannot drop primary key column "${col}"`);
          breaking.push(`Attempted drop of PK column ${col} on ${ks}.${tableName}`);
        } else {
          statements.push(`ALTER TABLE ${ks}.${tableName} DROP ${col};`);
          breaking.push(`Dropping column ${col} from ${ks}.${tableName}`);
        }
      }
    }

    // Column type changes
    for (const [col, colDef] of Object.entries(newDef.columns)) {
      if (col in oldDef.columns) {
        const oldType = oldDef.columns[col].type;
        const newType = colDef.type;
        if (oldType !== newType) {
          warnings.push(
            `Table ${ks}.${tableName}: Column "${col}" type changed from ${oldType} to ${newType}. ` +
            `Only compatible widening (e.g. int→bigint) is supported by ALTER.`
          );
          statements.push(`ALTER TABLE ${ks}.${tableName} ALTER ${col} TYPE ${newType};`);
        }
      }
    }

    // Index changes
    this._diffIndexes(ks, tableName, oldDef.indexes || [], newDef.indexes || [], statements);

    // Table option changes
    this._diffOptions(ks, tableName, oldDef.options || {}, newDef.options || {}, statements);
  }

  _diffIndexes(ks, tableName, oldIndexes, newIndexes, statements) {
    const normalize = (idx) => typeof idx === 'string'
      ? { column: idx, name: null, type: null, using: null }
      : idx;

    const oldNorm = oldIndexes.map(normalize);
    const newNorm = newIndexes.map(normalize);

    const oldCols = new Set(oldNorm.map(i => i.column));
    const newCols = new Set(newNorm.map(i => i.column));

    // New indexes
    for (const idx of newNorm) {
      if (!oldCols.has(idx.column)) {
        const name = idx.name ? `${idx.name} ` : '';
        let target = idx.column;
        if (idx.type === 'keys') target = `KEYS(${idx.column})`;
        else if (idx.type === 'values') target = `VALUES(${idx.column})`;
        else if (idx.type === 'entries') target = `ENTRIES(${idx.column})`;
        else if (idx.type === 'full') target = `FULL(${idx.column})`;

        let cql = `CREATE INDEX IF NOT EXISTS ${name}ON ${ks}.${tableName} (${target})`;
        if (idx.using) cql += ` USING '${idx.using}'`;
        statements.push(cql + ';');
      }
    }

    // Dropped indexes
    for (const idx of oldNorm) {
      if (!newCols.has(idx.column)) {
        const idxName = idx.name || `${ks}_${tableName}_${idx.column}_idx`;
        statements.push(`DROP INDEX IF EXISTS ${ks}.${idxName};`);
      }
    }
  }

  _diffOptions(ks, tableName, oldOpts, newOpts, statements) {
    const changes = [];
    const allKeys = new Set([...Object.keys(oldOpts), ...Object.keys(newOpts)]);

    for (const key of allKeys) {
      if (key === 'clustering_order') continue; // Can't change after creation
      const oldVal = JSON.stringify(oldOpts[key]);
      const newVal = JSON.stringify(newOpts[key]);
      if (oldVal !== newVal && newOpts[key] !== undefined) {
        if (typeof newOpts[key] === 'object') {
          const mapStr = Object.entries(newOpts[key])
            .map(([k, v]) => `'${k}': '${v}'`)
            .join(', ');
          changes.push(`${key} = {${mapStr}}`);
        } else if (typeof newOpts[key] === 'string') {
          changes.push(`${key} = '${newOpts[key]}'`);
        } else {
          changes.push(`${key} = ${newOpts[key]}`);
        }
      }
    }

    if (changes.length > 0) {
      statements.push(`ALTER TABLE ${ks}.${tableName} WITH ${changes.join(' AND ')};`);
    }
  }

  // ── Full table creation for new tables ──

  _createTable(ks, tableName, tableDef) {
    const stmts = [];
    const lines = [];

    for (const [colName, colDef] of Object.entries(tableDef.columns)) {
      const type = colDef.type;
      const isStatic = colDef.static ? ' STATIC' : '';
      lines.push(`  ${colName} ${type}${isStatic}`);
    }

    const pk = tableDef.partition_key;
    const ck = (tableDef.clustering_key || []).map(c => c.column);
    const pkPart = pk.length > 1 ? `(${pk.join(', ')})` : pk[0];
    const fullPK = ck.length > 0 ? `${pkPart}, ${ck.join(', ')}` : pkPart;
    lines.push(`  PRIMARY KEY (${fullPK})`);

    let cql = `CREATE TABLE IF NOT EXISTS ${ks}.${tableName} (\n${lines.join(',\n')}\n)`;

    const withClauses = [];
    const ckDefs = tableDef.clustering_key || [];
    if (ckDefs.some(c => c.order === 'DESC')) {
      const orderParts = ckDefs.map(c => `${c.column} ${c.order || 'ASC'}`);
      withClauses.push(`CLUSTERING ORDER BY (${orderParts.join(', ')})`);
    }

    const opts = tableDef.options || {};
    for (const [key, val] of Object.entries(opts)) {
      if (key === 'clustering_order') continue;
      if (typeof val === 'object') {
        const mapStr = Object.entries(val).map(([k, v]) => `'${k}': '${v}'`).join(', ');
        withClauses.push(`${key} = {${mapStr}}`);
      } else if (typeof val === 'string') {
        withClauses.push(`${key} = '${val}'`);
      } else {
        withClauses.push(`${key} = ${val}`);
      }
    }

    if (withClauses.length > 0) cql += `\nWITH ${withClauses.join('\n AND ')}`;
    stmts.push(cql + ';');

    // Indexes
    for (const idx of (tableDef.indexes || [])) {
      if (typeof idx === 'string') {
        stmts.push(`CREATE INDEX IF NOT EXISTS ON ${ks}.${tableName} (${idx});`);
      } else {
        const name = idx.name ? `${idx.name} ` : '';
        let target = idx.column;
        if (idx.type) target = `${idx.type.toUpperCase()}(${idx.column})`;
        let s = `CREATE INDEX IF NOT EXISTS ${name}ON ${ks}.${tableName} (${target})`;
        if (idx.using) s += ` USING '${idx.using}'`;
        stmts.push(s + ';');
      }
    }

    return stmts;
  }
}

module.exports = { MigrationDiffer };
