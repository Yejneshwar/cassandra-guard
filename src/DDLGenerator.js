const { SchemaRegistry } = require('./SchemaRegistry');

class DDLGenerator {
  constructor(registry) {
    if (!(registry instanceof SchemaRegistry)) {
      throw new Error('DDLGenerator requires a SchemaRegistry instance');
    }
    this._registry = registry;
  }

  /**
   * Generate full DDL for a keyspace (CREATE KEYSPACE + all types + all tables + indexes).
   */
  generateKeyspace(keyspace) {
    const schema = this._registry.get(keyspace);
    const statements = [];

    // CREATE KEYSPACE
    statements.push(this._createKeyspace(schema));

    // CREATE TYPES (before tables, since tables may reference them)
    for (const [typeName, typeDef] of Object.entries(schema.types || {})) {
      statements.push(this._createType(schema.keyspace, typeName, typeDef));
    }

    // CREATE TABLES
    for (const [tableName, tableDef] of Object.entries(schema.tables)) {
      statements.push(this._createTable(schema.keyspace, tableName, tableDef));

      // Indexes
      for (const idx of (tableDef.indexes || [])) {
        statements.push(this._createIndex(schema.keyspace, tableName, idx));
      }

      // Materialized views
      for (const [mvName, mvDef] of Object.entries(tableDef.materialized_views || {})) {
        statements.push(this._createMaterializedView(schema.keyspace, tableName, mvName, mvDef));
      }
    }

    return statements;
  }

  /**
   * Generate CREATE TABLE for a single table.
   */
  generateTable(keyspace, tableName) {
    const tableDef = this._registry.getTable(keyspace, tableName);
    const statements = [this._createTable(keyspace, tableName, tableDef)];

    for (const idx of (tableDef.indexes || [])) {
      statements.push(this._createIndex(keyspace, tableName, idx));
    }

    return statements;
  }

  // ── Internal generators ──

  _createKeyspace(schema) {
    const rep = schema.replication;
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

    const durable = schema.durable_writes === false ? ' AND durable_writes = false' : '';
    return `CREATE KEYSPACE IF NOT EXISTS ${schema.keyspace} WITH replication = ${repStr}${durable};`;
  }

  _createType(keyspace, typeName, typeDef) {
    const fields = Object.entries(typeDef.fields)
      .map(([name, type]) => `  ${name} ${type}`)
      .join(',\n');

    return `CREATE TYPE IF NOT EXISTS ${keyspace}.${typeName} (\n${fields}\n);`;
  }

  _createTable(keyspace, tableName, tableDef) {
    const lines = [];

    // Columns
    for (const [colName, colDef] of Object.entries(tableDef.columns)) {
      const type = colDef.type;
      const isStatic = colDef.static ? ' STATIC' : '';
      lines.push(`  ${colName} ${type}${isStatic}`);
    }

    // Primary key
    const pk = tableDef.partition_key;
    const ck = (tableDef.clustering_key || []).map(c => c.column);
    let pkStr;
    if (pk.length === 1 && ck.length === 0) {
      pkStr = pk[0];
    } else if (pk.length === 1) {
      pkStr = `${pk[0]}, ${ck.join(', ')}`;
    } else {
      pkStr = `(${pk.join(', ')}), ${ck.join(', ')}`;
    }
    // Wrap full primary key if there are clustering columns but single partition key
    if (ck.length > 0 && pk.length === 1) {
      pkStr = `${pk[0]}, ${ck.join(', ')}`;
    }
    lines.push(`  PRIMARY KEY (${pk.length > 1 ? `(${pk.join(', ')})` : pk[0]}${ck.length > 0 ? ', ' + ck.join(', ') : ''})`);

    let cql = `CREATE TABLE IF NOT EXISTS ${keyspace}.${tableName} (\n${lines.join(',\n')}\n)`;

    // Table options
    const withClauses = [];

    // Clustering order
    const ckDefs = tableDef.clustering_key || [];
    const nonDefaultOrders = ckDefs.filter(c => c.order === 'DESC');
    if (nonDefaultOrders.length > 0) {
      const orderParts = ckDefs.map(c => `${c.column} ${c.order || 'ASC'}`);
      withClauses.push(`CLUSTERING ORDER BY (${orderParts.join(', ')})`);
    }

    // Other options
    const opts = tableDef.options || {};
    if (opts.default_time_to_live !== undefined) {
      withClauses.push(`default_time_to_live = ${opts.default_time_to_live}`);
    }
    if (opts.gc_grace_seconds !== undefined) {
      withClauses.push(`gc_grace_seconds = ${opts.gc_grace_seconds}`);
    }
    if (opts.bloom_filter_fp_chance !== undefined) {
      withClauses.push(`bloom_filter_fp_chance = ${opts.bloom_filter_fp_chance}`);
    }
    if (opts.comment) {
      withClauses.push(`comment = '${opts.comment.replace(/'/g, "''")}'`);
    }
    if (opts.cdc !== undefined) {
      withClauses.push(`cdc = ${JSON.stringify(opts.cdc)}`);
    }
    if (opts.compaction) {
      withClauses.push(`compaction = ${this._mapToString(opts.compaction)}`);
    }
    if (opts.compression) {
      withClauses.push(`compression = ${this._mapToString(opts.compression)}`);
    }
    if (opts.caching) {
      withClauses.push(`caching = ${this._mapToString(opts.caching)}`);
    }

    if (withClauses.length > 0) {
      cql += `\nWITH ${withClauses.join('\n AND ')}`;
    }

    return cql + ';';
  }

  _createIndex(keyspace, tableName, idx) {
    if (typeof idx === 'string') {
      return `CREATE INDEX IF NOT EXISTS ON ${keyspace}.${tableName} (${idx});`;
    }

    const name = idx.name ? `${idx.name} ` : '';
    let target = idx.column;
    if (idx.type === 'keys') target = `KEYS(${idx.column})`;
    else if (idx.type === 'values') target = `VALUES(${idx.column})`;
    else if (idx.type === 'entries') target = `ENTRIES(${idx.column})`;
    else if (idx.type === 'full') target = `FULL(${idx.column})`;

    let cql = `CREATE INDEX IF NOT EXISTS ${name}ON ${keyspace}.${tableName} (${target})`;
    if (idx.using) {
      cql += ` USING '${idx.using}'`;
    }
    return cql + ';';
  }

  _createMaterializedView(keyspace, baseTable, mvName, mvDef) {
    const select = mvDef.select.join(', ');
    const pk = mvDef.partition_key;
    const ck = (mvDef.clustering_key || []).map(c => typeof c === 'string' ? c : c.column);
    const whereClause = mvDef.where.map(w => `${w} IS NOT NULL`).join(' AND ');

    let pkStr;
    if (pk.length > 1) {
      pkStr = `(${pk.join(', ')})`;
    } else {
      pkStr = pk[0];
    }
    if (ck.length > 0) {
      pkStr += `, ${ck.join(', ')}`;
    }

    return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${keyspace}.${mvName} AS
  SELECT ${select}
  FROM ${keyspace}.${baseTable}
  WHERE ${whereClause}
  PRIMARY KEY (${pkStr});`;
  }

  _mapToString(obj) {
    const entries = Object.entries(obj)
      .map(([k, v]) => `'${k}': '${v}'`)
      .join(', ');
    return `{${entries}}`;
  }
}

module.exports = { DDLGenerator };
