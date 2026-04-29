const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const metaSchema = require('./meta-schema.json');

class SchemaValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

class SchemaRegistry {
  constructor() {
    this._schemas = new Map();
    this._ajv = new Ajv({ allErrors: true, strict: false });
    this._validate = this._ajv.compile(metaSchema);
  }

  /**
   * Load a schema from a JSON file path.
   */
  loadFromFile(filePath) {
    const resolved = path.resolve(filePath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    let schema;
    try {
      schema = JSON.parse(raw);
    } catch (err) {
      throw new SchemaValidationError(`Invalid JSON in ${filePath}: ${err.message}`);
    }
    return this.register(schema);
  }

  /**
   * Load all .json files from a directory.
   */
  loadFromDirectory(dirPath) {
    const resolved = path.resolve(dirPath);
    const files = fs.readdirSync(resolved).filter(f => f.endsWith('.json'));
    const loaded = [];
    for (const file of files) {
      loaded.push(this.loadFromFile(path.join(resolved, file)));
    }
    return loaded;
  }

  /**
   * Register a schema object directly. Validates against meta-schema.
   */
  register(schema) {
    const valid = this._validate(schema);
    if (!valid) {
      const messages = this._validate.errors.map(e => `${e.instancePath} ${e.message}`);
      throw new SchemaValidationError(
        `Schema validation failed:\n  ${messages.join('\n  ')}`,
        this._validate.errors
      );
    }

    // Cross-validate internal references
    this._crossValidate(schema);

    const keyspace = schema.keyspace;
    this._schemas.set(keyspace, Object.freeze(this._normalize(schema)));
    return keyspace;
  }

  /**
   * Get a registered schema by keyspace name.
   */
  get(keyspace) {
    const schema = this._schemas.get(keyspace);
    if (!schema) {
      throw new Error(`No schema registered for keyspace "${keyspace}". Available: [${[...this._schemas.keys()].join(', ')}]`);
    }
    return schema;
  }

  /**
   * Get table definition from a keyspace schema.
   */
  getTable(keyspace, table) {
    const schema = this.get(keyspace);
    const tableDef = schema.tables[table];
    if (!tableDef) {
      throw new Error(
        `Table "${table}" not found in keyspace "${keyspace}". Available tables: [${Object.keys(schema.tables).join(', ')}]`
      );
    }
    return tableDef;
  }

  /**
   * List all registered keyspaces.
   */
  listKeyspaces() {
    return [...this._schemas.keys()];
  }

  /**
   * List all tables in a keyspace.
   */
  listTables(keyspace) {
    return Object.keys(this.get(keyspace).tables);
  }

  /**
   * Get columns for a specific table.
   */
  getColumns(keyspace, table) {
    const tableDef = this.getTable(keyspace, table);
    return Object.keys(tableDef.columns);
  }

  /**
   * Get the resolved type of a column (string form).
   */
  getColumnType(keyspace, table, column) {
    const tableDef = this.getTable(keyspace, table);
    const colDef = tableDef.columns[column];
    if (!colDef) {
      throw new Error(
        `Column "${column}" not found in table "${keyspace}.${table}". Available columns: [${Object.keys(tableDef.columns).join(', ')}]`
      );
    }
    return typeof colDef === 'string' ? colDef : colDef.type;
  }

  /**
   * Check if a column exists in a table.
   */
  hasColumn(keyspace, table, column) {
    const tableDef = this.getTable(keyspace, table);
    return column in tableDef.columns;
  }

  /**
   * Return partition key columns for a table.
   */
  getPartitionKey(keyspace, table) {
    return this.getTable(keyspace, table).partition_key;
  }

  /**
   * Return clustering key columns for a table.
   */
  getClusteringKey(keyspace, table) {
    const ck = this.getTable(keyspace, table).clustering_key || [];
    return ck.map(c => typeof c === 'string' ? { column: c, order: 'ASC' } : c);
  }

  /**
   * Return the full primary key (partition + clustering) columns.
   */
  getPrimaryKey(keyspace, table) {
    const pk = this.getPartitionKey(keyspace, table);
    const ck = this.getClusteringKey(keyspace, table).map(c => c.column);
    return [...pk, ...ck];
  }

  /**
   * Get the field definitions for a UDT by name.
   * Returns an object mapping field names to their types.
   */
  getUDTFields(keyspace, typeName) {
    const schema = this.get(keyspace);
    const udt = (schema.types || {})[typeName];
    if (!udt) {
      throw new Error(
        `UDT "${typeName}" not found in keyspace "${keyspace}". Available types: [${Object.keys(schema.types || {}).join(', ')}]`
      );
    }
    return udt.fields;
  }

  /**
   * Resolve a column to its UDT type and validate a subfield exists.
   * Handles both bare UDT names and frozen<udt_name> column types.
   * Rejects frozen UDTs since Cassandra does not allow subfield updates on them.
   * Returns the UDT fields object.
   */
  resolveColumnUDT(keyspace, table, column, field) {
    const colType = this.getColumnType(keyspace, table, column);

    // Extract UDT name from the column type (e.g. "frozen<address>" → "address", or bare "address")
    let typeName = colType;
    const frozenMatch = colType.match(/^frozen<([a-zA-Z_][a-zA-Z0-9_]*)>$/);
    if (frozenMatch) {
      throw new Error(
        `Cannot update individual fields of frozen UDT column "${column}" (type: ${colType}). ` +
        `Cassandra requires replacing the entire value. Use .set("${column}", {...}) instead, ` +
        `or change the schema to use a non-frozen UDT.`
      );
    }

    const fields = this.getUDTFields(keyspace, typeName);
    if (!(field in fields)) {
      throw new Error(
        `Field "${field}" not found in UDT "${typeName}". Available fields: [${Object.keys(fields).join(', ')}]`
      );
    }
    return fields;
  }

  // ── Internal ──

  /**
   * Normalize column definitions so they are always objects.
   */
  _normalize(schema) {
    const normalized = JSON.parse(JSON.stringify(schema));
    for (const [, tableDef] of Object.entries(normalized.tables)) {
      for (const [colName, colDef] of Object.entries(tableDef.columns)) {
        if (typeof colDef === 'string') {
          tableDef.columns[colName] = { type: colDef, static: false };
        }
      }
      if (!tableDef.clustering_key) tableDef.clustering_key = [];
      if (!tableDef.indexes) tableDef.indexes = [];
      if (!tableDef.options) tableDef.options = {};
    }
    if (!normalized.types) normalized.types = {};
    if (!normalized.replication) {
      normalized.replication = { class: 'SimpleStrategy', replication_factor: 1 };
    }
    return normalized;
  }

  /**
   * Cross-validate: partition/clustering keys reference real columns,
   * indexes reference real columns, etc.
   */
  _crossValidate(schema) {
    const errors = [];
    for (const [tableName, tableDef] of Object.entries(schema.tables)) {
      const cols = Object.keys(tableDef.columns);

      // Partition key columns must exist
      for (const pk of tableDef.partition_key) {
        if (!cols.includes(pk)) {
          errors.push(`Table "${tableName}": partition key column "${pk}" not found in columns`);
        }
      }

      // Clustering key columns must exist
      for (const ck of (tableDef.clustering_key || [])) {
        const colName = typeof ck === 'string' ? ck : ck.column;
        if (!cols.includes(colName)) {
          errors.push(`Table "${tableName}": clustering key column "${colName}" not found in columns`);
        }
      }

      // Index columns must exist
      for (const idx of (tableDef.indexes || [])) {
        const colName = typeof idx === 'string' ? idx : idx.column;
        if (!cols.includes(colName)) {
          errors.push(`Table "${tableName}": index column "${colName}" not found in columns`);
        }
      }

      // Materialized view columns must exist
      for (const [mvName, mvDef] of Object.entries(tableDef.materialized_views || {})) {
        for (const sel of mvDef.select) {
          if (sel !== '*' && !cols.includes(sel)) {
            errors.push(`Table "${tableName}" MV "${mvName}": select column "${sel}" not found`);
          }
        }
        for (const pk of mvDef.partition_key) {
          if (!cols.includes(pk)) {
            errors.push(`Table "${tableName}" MV "${mvName}": partition key "${pk}" not found`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new SchemaValidationError(
        `Schema cross-validation failed:\n  ${errors.join('\n  ')}`,
        errors
      );
    }
  }
}

module.exports = { SchemaRegistry, SchemaValidationError };
