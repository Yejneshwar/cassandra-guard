/**
 * LiveSchemaIntrospector — connects to a Cassandra cluster and reads
 * the actual schema from system_schema tables, converting it to the
 * same normalized JSON format used by SchemaRegistry.
 *
 * This lets you diff your JSON definition against the live cluster.
 */

class LiveSchemaIntrospector {
  /**
   * @param {import('cassandra-driver').Client} client — connected cassandra-driver client
   */
  constructor(client) {
    this._client = client;
  }

  /**
   * The server's release version from system.local (e.g. "4.1.9", "5.0.2").
   * Feed it to `new CQLBuilder(registry, { cassandraVersion })` to enable
   * version-gated features against exactly the cluster you're connected to.
   */
  async releaseVersion() {
    const result = await this._client.execute('SELECT release_version FROM system.local');
    return result.rows[0].release_version;
  }

  /**
   * Introspect a keyspace and return a normalized schema object.
   */
  async introspect(keyspace) {
    const [ksInfo, tables, columns, indexes, types] = await Promise.all([
      this._getKeyspace(keyspace),
      this._getTables(keyspace),
      this._getColumns(keyspace),
      this._getIndexes(keyspace),
      this._getTypes(keyspace),
    ]);

    if (!ksInfo) {
      throw new Error(`Keyspace "${keyspace}" does not exist in the cluster`);
    }

    const schema = {
      keyspace,
      replication: this._parseReplication(ksInfo.replication),
      durable_writes: ksInfo.durable_writes,
      types: {},
      tables: {},
    };

    // UDTs
    for (const udt of types) {
      const fields = {};
      for (let i = 0; i < udt.field_names.length; i++) {
        fields[udt.field_names[i]] = udt.field_types[i];
      }
      schema.types[udt.type_name] = { fields };
    }

    // Tables
    for (const table of tables) {
      const tableName = table.table_name;
      const tableCols = columns.filter(c => c.table_name === tableName);
      const tableIndexes = indexes.filter(i => i.table_name === tableName);

      const colDefs = {};
      const partitionKey = [];
      const clusteringKey = [];

      // Sort by position for key columns
      const pkCols = tableCols.filter(c => c.kind === 'partition_key').sort((a, b) => a.position - b.position);
      const ckCols = tableCols.filter(c => c.kind === 'clustering').sort((a, b) => a.position - b.position);

      for (const col of tableCols) {
        colDefs[col.column_name] = {
          type: col.type,
          static: col.kind === 'static',
        };
      }

      for (const col of pkCols) {
        partitionKey.push(col.column_name);
      }

      for (const col of ckCols) {
        clusteringKey.push({
          column: col.column_name,
          order: col.clustering_order === 'desc' ? 'DESC' : 'ASC',
        });
      }

      const idxDefs = tableIndexes.map(idx => ({
        name: idx.index_name,
        column: idx.options?.target || 'unknown',
        type: null,
        using: idx.kind !== 'composites' ? idx.kind : null,
      }));

      const opts = {};
      if (table.default_time_to_live) opts.default_time_to_live = table.default_time_to_live;
      if (table.gc_grace_seconds) opts.gc_grace_seconds = table.gc_grace_seconds;
      if (table.bloom_filter_fp_chance) opts.bloom_filter_fp_chance = table.bloom_filter_fp_chance;
      if (table.comment) opts.comment = table.comment;

      schema.tables[tableName] = {
        columns: colDefs,
        partition_key: partitionKey,
        clustering_key: clusteringKey,
        indexes: idxDefs,
        options: opts,
      };
    }

    return schema;
  }

  async _getKeyspace(keyspace) {
    const result = await this._client.execute(
      'SELECT * FROM system_schema.keyspaces WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    return result.rows[0] || null;
  }

  async _getTables(keyspace) {
    const result = await this._client.execute(
      'SELECT * FROM system_schema.tables WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    return result.rows;
  }

  async _getColumns(keyspace) {
    const result = await this._client.execute(
      'SELECT * FROM system_schema.columns WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    return result.rows;
  }

  async _getIndexes(keyspace) {
    const result = await this._client.execute(
      'SELECT * FROM system_schema.indexes WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    return result.rows;
  }

  async _getTypes(keyspace) {
    const result = await this._client.execute(
      'SELECT * FROM system_schema.types WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    return result.rows;
  }

  _parseReplication(repMap) {
    const result = {};
    for (const [key, val] of repMap.entries ? repMap.entries() : Object.entries(repMap)) {
      if (key === 'class') {
        result.class = val.replace('org.apache.cassandra.locator.', '');
      } else if (key === 'replication_factor') {
        result.replication_factor = parseInt(val, 10);
      } else {
        result[key] = parseInt(val, 10);
      }
    }
    return result;
  }
}

module.exports = { LiveSchemaIntrospector };
