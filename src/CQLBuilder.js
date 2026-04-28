const { SchemaRegistry } = require('./SchemaRegistry');

class CQLBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CQLBuildError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeIdentifier(name) {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return `"${name}"`;
}

const COMPARISON_OPS = ['=', '!=', '<', '>', '<=', '>=', 'IN', 'CONTAINS', 'CONTAINS KEY'];

function buildWhereClause(conditions) {
  if (!conditions || conditions.length === 0) return { cql: '', params: [] };
  const parts = [];
  const params = [];
  for (const cond of conditions) {
    const op = (cond.op || '=').toUpperCase();
    if (!COMPARISON_OPS.includes(op)) {
      throw new CQLBuildError(`Invalid comparison operator: "${cond.op}"`);
    }
    if (op === 'IN') {
      parts.push(`${escapeIdentifier(cond.column)} IN ?`);
    } else {
      parts.push(`${escapeIdentifier(cond.column)} ${op} ?`);
    }
    params.push(cond.value);
  }
  return { cql: `WHERE ${parts.join(' AND ')}`, params };
}

/**
 * Shared guard: throws if the builder has already been built.
 * Every mutator and build() call this first.
 */
function guardSealed(builder, method) {
  if (builder._sealed) {
    throw new CQLBuildError(
      `Cannot call .${method}() — this builder has already been built. ` +
      `Each builder produces exactly one statement. Use .clone() before .build() if you need variants.`
    );
  }
}

// ─── SELECT Builder ──────────────────────────────────────────────────────────

class SelectBuilder {
  constructor(registry, keyspace, table) {
    this._registry = registry;
    this._keyspace = keyspace;
    this._table = table;
    this._columns = [];
    this._where = [];
    this._orderBy = [];
    this._limit = null;
    this._allowFiltering = false;
    this._perPartitionLimit = null;
    this._distinct = false;
    this._sealed = false;

    registry.getTable(keyspace, table);
  }

  columns(...cols) {
    guardSealed(this, 'columns');
    const flat = cols.flat();
    for (const c of flat) {
      this._validateColumn(c);
    }
    this._columns = flat;
    return this;
  }

  distinct() {
    guardSealed(this, 'distinct');
    this._distinct = true;
    return this;
  }

  where(column, opOrValue, value) {
    guardSealed(this, 'where');
    this._validateColumn(column);
    if (value === undefined) {
      this._where.push({ column, op: '=', value: opOrValue });
    } else {
      this._where.push({ column, op: opOrValue, value });
    }
    return this;
  }

  andWhere(column, opOrValue, value) {
    return this.where(column, opOrValue, value);
  }

  orderBy(column, direction = 'ASC') {
    guardSealed(this, 'orderBy');
    this._validateColumn(column);
    const dir = direction.toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new CQLBuildError(`Invalid order direction: "${direction}"`);
    }
    const ck = this._registry.getClusteringKey(this._keyspace, this._table);
    const ckCols = ck.map(c => c.column);
    if (!ckCols.includes(column)) {
      throw new CQLBuildError(
        `Cannot ORDER BY "${column}" — only clustering columns can be used: [${ckCols.join(', ')}]`
      );
    }
    this._orderBy.push({ column, direction: dir });
    return this;
  }

  limit(n) {
    guardSealed(this, 'limit');
    if (!Number.isInteger(n) || n <= 0) {
      throw new CQLBuildError(`LIMIT must be a positive integer, got: ${n}`);
    }
    this._limit = n;
    return this;
  }

  perPartitionLimit(n) {
    guardSealed(this, 'perPartitionLimit');
    if (!Number.isInteger(n) || n <= 0) {
      throw new CQLBuildError(`PER PARTITION LIMIT must be a positive integer, got: ${n}`);
    }
    this._perPartitionLimit = n;
    return this;
  }

  allowFiltering() {
    guardSealed(this, 'allowFiltering');
    this._allowFiltering = true;
    return this;
  }

  clone() {
    const c = new SelectBuilder(this._registry, this._keyspace, this._table);
    c._columns = [...this._columns];
    c._where = this._where.map(w => ({ ...w }));
    c._orderBy = this._orderBy.map(o => ({ ...o }));
    c._limit = this._limit;
    c._allowFiltering = this._allowFiltering;
    c._perPartitionLimit = this._perPartitionLimit;
    c._distinct = this._distinct;
    return c;
  }

  build() {
    guardSealed(this, 'build');

    const selectCols = this._columns.length > 0
      ? this._columns.map(escapeIdentifier).join(', ')
      : '*';

    const distinct = this._distinct ? 'DISTINCT ' : '';
    let cql = `SELECT ${distinct}${selectCols} FROM ${escapeIdentifier(this._keyspace)}.${escapeIdentifier(this._table)}`;

    const { cql: whereCql, params } = buildWhereClause(this._where);
    if (whereCql) cql += ` ${whereCql}`;

    if (this._orderBy.length > 0) {
      const orderParts = this._orderBy.map(o => `${escapeIdentifier(o.column)} ${o.direction}`);
      cql += ` ORDER BY ${orderParts.join(', ')}`;
    }

    if (this._perPartitionLimit !== null) {
      cql += ` PER PARTITION LIMIT ${this._perPartitionLimit}`;
    }

    if (this._limit !== null) {
      cql += ` LIMIT ${this._limit}`;
    }

    if (this._allowFiltering) {
      cql += ' ALLOW FILTERING';
    }

    this._sealed = true;
    return { cql, params };
  }

  _validateColumn(column) {
    if (!this._registry.hasColumn(this._keyspace, this._table, column)) {
      throw new CQLBuildError(
        `Column "${column}" does not exist in ${this._keyspace}.${this._table}. ` +
        `Available: [${this._registry.getColumns(this._keyspace, this._table).join(', ')}]`
      );
    }
  }
}

// ─── INSERT Builder ──────────────────────────────────────────────────────────

class InsertBuilder {
  constructor(registry, keyspace, table) {
    this._registry = registry;
    this._keyspace = keyspace;
    this._table = table;
    this._values = {};
    this._ttl = null;
    this._timestamp = null;
    this._ifNotExists = false;
    this._sealed = false;

    registry.getTable(keyspace, table);
  }

  value(column, val) {
    guardSealed(this, 'value');
    this._validateColumn(column);
    this._values[column] = val;
    return this;
  }

  values(obj) {
    guardSealed(this, 'values');
    for (const [col, val] of Object.entries(obj)) {
      this._validateColumn(col);
      this._values[col] = val;
    }
    return this;
  }

  ttl(seconds) {
    guardSealed(this, 'ttl');
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new CQLBuildError(`TTL must be a positive integer, got: ${seconds}`);
    }
    this._ttl = seconds;
    return this;
  }

  timestamp(ts) {
    guardSealed(this, 'timestamp');
    this._timestamp = ts;
    return this;
  }

  ifNotExists() {
    guardSealed(this, 'ifNotExists');
    this._ifNotExists = true;
    return this;
  }

  clone() {
    const c = new InsertBuilder(this._registry, this._keyspace, this._table);
    c._values = { ...this._values };
    c._ttl = this._ttl;
    c._timestamp = this._timestamp;
    c._ifNotExists = this._ifNotExists;
    return c;
  }

  build() {
    guardSealed(this, 'build');

    const pk = this._registry.getPrimaryKey(this._keyspace, this._table);
    const missingPk = pk.filter(k => !(k in this._values));
    if (missingPk.length > 0) {
      throw new CQLBuildError(
        `INSERT into ${this._keyspace}.${this._table} is missing primary key columns: [${missingPk.join(', ')}]`
      );
    }

    const cols = Object.keys(this._values);
    const placeholders = cols.map(() => '?');
    const params = cols.map(c => this._values[c]);

    let cql = `INSERT INTO ${escapeIdentifier(this._keyspace)}.${escapeIdentifier(this._table)} (${cols.map(escapeIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`;

    if (this._ifNotExists) {
      cql += ' IF NOT EXISTS';
    }

    const using = [];
    if (this._ttl !== null) using.push(`TTL ${this._ttl}`);
    if (this._timestamp !== null) using.push(`TIMESTAMP ${this._timestamp}`);
    if (using.length > 0) {
      cql += ` USING ${using.join(' AND ')}`;
    }

    this._sealed = true;
    return { cql, params };
  }

  _validateColumn(column) {
    if (!this._registry.hasColumn(this._keyspace, this._table, column)) {
      throw new CQLBuildError(
        `Column "${column}" does not exist in ${this._keyspace}.${this._table}. ` +
        `Available: [${this._registry.getColumns(this._keyspace, this._table).join(', ')}]`
      );
    }
  }
}

// ─── UPDATE Builder ──────────────────────────────────────────────────────────

class UpdateBuilder {
  constructor(registry, keyspace, table) {
    this._registry = registry;
    this._keyspace = keyspace;
    this._table = table;
    this._sets = [];
    this._where = [];
    this._ifs = [];
    this._ifExists = false;
    this._ttl = null;
    this._timestamp = null;
    this._sealed = false;

    registry.getTable(keyspace, table);
  }

  set(column, value) {
    guardSealed(this, 'set');
    this._validateColumn(column);
    this._validateNotPrimaryKeyColumn(column);
    this._sets.push({ type: 'set', column, value });
    return this;
  }

  setAll(obj) {
    guardSealed(this, 'setAll');
    for (const [col, val] of Object.entries(obj)) {
      this._validateColumn(col);
      this._validateNotPrimaryKeyColumn(col);
      this._sets.push({ type: 'set', column: col, value: val });
    }
    return this;
  }

  increment(column, value) {
    guardSealed(this, 'increment');
    this._validateColumn(column);
    const type = this._registry.getColumnType(this._keyspace, this._table, column);
    if (type !== 'counter') {
      throw new CQLBuildError(`Cannot increment non-counter column "${column}" (type: ${type})`);
    }
    this._sets.push({ type: 'increment', column, value });
    return this;
  }

  decrement(column, value) {
    guardSealed(this, 'decrement');
    this._validateColumn(column);
    const type = this._registry.getColumnType(this._keyspace, this._table, column);
    if (type !== 'counter') {
      throw new CQLBuildError(`Cannot decrement non-counter column "${column}" (type: ${type})`);
    }
    this._sets.push({ type: 'decrement', column, value });
    return this;
  }

  appendToList(column, value) {
    guardSealed(this, 'appendToList');
    this._validateCollectionOp(column, 'list');
    this._sets.push({ type: 'list_append', column, value });
    return this;
  }

  prependToList(column, value) {
    guardSealed(this, 'prependToList');
    this._validateCollectionOp(column, 'list');
    this._sets.push({ type: 'list_prepend', column, value });
    return this;
  }

  addToSet(column, value) {
    guardSealed(this, 'addToSet');
    this._validateCollectionOp(column, 'set');
    this._sets.push({ type: 'set_add', column, value });
    return this;
  }

  removeFromSet(column, value) {
    guardSealed(this, 'removeFromSet');
    this._validateCollectionOp(column, 'set');
    this._sets.push({ type: 'set_remove', column, value });
    return this;
  }

  putToMap(column, key, value) {
    guardSealed(this, 'putToMap');
    this._validateCollectionOp(column, 'map');
    this._sets.push({ type: 'map_put', column, key, value });
    return this;
  }

  where(column, opOrValue, value) {
    guardSealed(this, 'where');
    this._validateColumn(column);
    if (value === undefined) {
      this._where.push({ column, op: '=', value: opOrValue });
    } else {
      this._where.push({ column, op: opOrValue, value });
    }
    return this;
  }

  if_(column, opOrValue, value) {
    guardSealed(this, 'if_');
    this._validateColumn(column);
    if (value === undefined) {
      this._ifs.push({ column, op: '=', value: opOrValue });
    } else {
      this._ifs.push({ column, op: opOrValue, value });
    }
    return this;
  }

  ifExists() {
    guardSealed(this, 'ifExists');
    this._ifExists = true;
    return this;
  }

  ttl(seconds) {
    guardSealed(this, 'ttl');
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new CQLBuildError(`TTL must be a positive integer, got: ${seconds}`);
    }
    this._ttl = seconds;
    return this;
  }

  timestamp(ts) {
    guardSealed(this, 'timestamp');
    this._timestamp = ts;
    return this;
  }

  clone() {
    const c = new UpdateBuilder(this._registry, this._keyspace, this._table);
    c._sets = this._sets.map(s => ({ ...s }));
    c._where = this._where.map(w => ({ ...w }));
    c._ifs = this._ifs.map(i => ({ ...i }));
    c._ifExists = this._ifExists;
    c._ttl = this._ttl;
    c._timestamp = this._timestamp;
    return c;
  }

  build() {
    guardSealed(this, 'build');

    if (this._sets.length === 0) {
      throw new CQLBuildError('UPDATE requires at least one SET clause');
    }
    if (this._where.length === 0) {
      throw new CQLBuildError('UPDATE requires a WHERE clause');
    }

    this._validateWherePrimaryKey();

    const params = [];
    let cql = `UPDATE ${escapeIdentifier(this._keyspace)}.${escapeIdentifier(this._table)}`;

    const using = [];
    if (this._ttl !== null) using.push(`TTL ${this._ttl}`);
    if (this._timestamp !== null) using.push(`TIMESTAMP ${this._timestamp}`);
    if (using.length > 0) {
      cql += ` USING ${using.join(' AND ')}`;
    }

    const setParts = [];
    for (const s of this._sets) {
      const col = escapeIdentifier(s.column);
      switch (s.type) {
        case 'set':
          setParts.push(`${col} = ?`);
          params.push(s.value);
          break;
        case 'increment':
          setParts.push(`${col} = ${col} + ?`);
          params.push(s.value);
          break;
        case 'decrement':
          setParts.push(`${col} = ${col} - ?`);
          params.push(s.value);
          break;
        case 'list_append':
          setParts.push(`${col} = ${col} + ?`);
          params.push(s.value);
          break;
        case 'list_prepend':
          setParts.push(`${col} = ? + ${col}`);
          params.push(s.value);
          break;
        case 'set_add':
          setParts.push(`${col} = ${col} + ?`);
          params.push(s.value);
          break;
        case 'set_remove':
          setParts.push(`${col} = ${col} - ?`);
          params.push(s.value);
          break;
        case 'map_put':
          setParts.push(`${col}[?] = ?`);
          params.push(s.key, s.value);
          break;
      }
    }
    cql += ` SET ${setParts.join(', ')}`;

    const { cql: whereCql, params: whereParams } = buildWhereClause(this._where);
    cql += ` ${whereCql}`;
    params.push(...whereParams);

    if (this._ifExists) {
      cql += ' IF EXISTS';
    } else if (this._ifs.length > 0) {
      const { cql: ifCql, params: ifParams } = buildWhereClause(this._ifs);
      cql += ` IF ${ifCql.replace('WHERE ', '')}`;
      params.push(...ifParams);
    }

    this._sealed = true;
    return { cql, params };
  }

  _validateColumn(column) {
    if (!this._registry.hasColumn(this._keyspace, this._table, column)) {
      throw new CQLBuildError(
        `Column "${column}" does not exist in ${this._keyspace}.${this._table}. ` +
        `Available: [${this._registry.getColumns(this._keyspace, this._table).join(', ')}]`
      );
    }
  }

  _validateNotPrimaryKeyColumn(column) {
    const pk = this._registry.getPrimaryKey(this._keyspace, this._table);
    if (pk.includes(column)) {
      throw new CQLBuildError(
        `Cannot SET primary key column "${column}" in UPDATE. Primary key: [${pk.join(', ')}]`
      );
    }
  }

  _validateCollectionOp(column, expectedPrefix) {
    this._validateColumn(column);
    this._validateNotPrimaryKeyColumn(column);
    const type = this._registry.getColumnType(this._keyspace, this._table, column);
    if (!type.startsWith(expectedPrefix + '<')) {
      throw new CQLBuildError(
        `Collection operation requires "${expectedPrefix}<...>" column, but "${column}" is "${type}"`
      );
    }
  }

  _validateWherePrimaryKey() {
    const pk = this._registry.getPrimaryKey(this._keyspace, this._table);
    const whereCols = this._where.map(w => w.column);
    const missingPk = pk.filter(k => !whereCols.includes(k));
    if (missingPk.length > 0) {
      throw new CQLBuildError(
        `UPDATE WHERE must include all primary key columns. Missing: [${missingPk.join(', ')}]. ` +
        `Primary key: [${pk.join(', ')}]`
      );
    }
  }
}

// ─── DELETE Builder ──────────────────────────────────────────────────────────

class DeleteBuilder {
  constructor(registry, keyspace, table) {
    this._registry = registry;
    this._keyspace = keyspace;
    this._table = table;
    this._columns = [];
    this._where = [];
    this._ifs = [];
    this._ifExists = false;
    this._timestamp = null;
    this._sealed = false;

    registry.getTable(keyspace, table);
  }

  columns(...cols) {
    guardSealed(this, 'columns');
    const flat = cols.flat();
    for (const c of flat) {
      this._validateColumn(c);
    }
    this._columns = flat;
    return this;
  }

  where(column, opOrValue, value) {
    guardSealed(this, 'where');
    this._validateColumn(column);
    if (value === undefined) {
      this._where.push({ column, op: '=', value: opOrValue });
    } else {
      this._where.push({ column, op: opOrValue, value });
    }
    return this;
  }

  if_(column, opOrValue, value) {
    guardSealed(this, 'if_');
    this._validateColumn(column);
    if (value === undefined) {
      this._ifs.push({ column, op: '=', value: opOrValue });
    } else {
      this._ifs.push({ column, op: opOrValue, value });
    }
    return this;
  }

  ifExists() {
    guardSealed(this, 'ifExists');
    this._ifExists = true;
    return this;
  }

  timestamp(ts) {
    guardSealed(this, 'timestamp');
    this._timestamp = ts;
    return this;
  }

  clone() {
    const c = new DeleteBuilder(this._registry, this._keyspace, this._table);
    c._columns = [...this._columns];
    c._where = this._where.map(w => ({ ...w }));
    c._ifs = this._ifs.map(i => ({ ...i }));
    c._ifExists = this._ifExists;
    c._timestamp = this._timestamp;
    return c;
  }

  build() {
    guardSealed(this, 'build');

    if (this._where.length === 0) {
      throw new CQLBuildError('DELETE requires a WHERE clause');
    }

    const params = [];
    const deleteCols = this._columns.length > 0
      ? this._columns.map(escapeIdentifier).join(', ') + ' '
      : '';

    let cql = `DELETE ${deleteCols}FROM ${escapeIdentifier(this._keyspace)}.${escapeIdentifier(this._table)}`;

    if (this._timestamp !== null) {
      cql += ` USING TIMESTAMP ${this._timestamp}`;
    }

    const { cql: whereCql, params: whereParams } = buildWhereClause(this._where);
    cql += ` ${whereCql}`;
    params.push(...whereParams);

    if (this._ifExists) {
      cql += ' IF EXISTS';
    } else if (this._ifs.length > 0) {
      const { cql: ifCql, params: ifParams } = buildWhereClause(this._ifs);
      cql += ` IF ${ifCql.replace('WHERE ', '')}`;
      params.push(...ifParams);
    }

    this._sealed = true;
    return { cql, params };
  }

  _validateColumn(column) {
    if (!this._registry.hasColumn(this._keyspace, this._table, column)) {
      throw new CQLBuildError(
        `Column "${column}" does not exist in ${this._keyspace}.${this._table}. ` +
        `Available: [${this._registry.getColumns(this._keyspace, this._table).join(', ')}]`
      );
    }
  }
}

// ─── BATCH Builder ───────────────────────────────────────────────────────────

class BatchBuilder {
  constructor(type = 'LOGGED') {
    const t = type.toUpperCase();
    if (!['LOGGED', 'UNLOGGED', 'COUNTER'].includes(t)) {
      throw new CQLBuildError(`Invalid batch type: "${type}". Must be LOGGED, UNLOGGED, or COUNTER`);
    }
    this._type = t;
    this._statements = [];
    this._timestamp = null;
    this._sealed = false;
  }

  add(builder) {
    guardSealed(this, 'add');
    if (typeof builder.build !== 'function') {
      throw new CQLBuildError('Batch statements must have a build() method');
    }
    this._statements.push(builder);
    return this;
  }

  timestamp(ts) {
    guardSealed(this, 'timestamp');
    this._timestamp = ts;
    return this;
  }

  clone() {
    const c = new BatchBuilder(this._type);
    c._statements = this._statements.map(s => (typeof s.clone === 'function') ? s.clone() : s);
    c._timestamp = this._timestamp;
    return c;
  }

  build() {
    guardSealed(this, 'build');

    if (this._statements.length === 0) {
      throw new CQLBuildError('BATCH must contain at least one statement');
    }

    const allParams = [];
    let cql = `BEGIN ${this._type === 'LOGGED' ? '' : this._type + ' '}BATCH`;

    if (this._timestamp !== null) {
      cql += ` USING TIMESTAMP ${this._timestamp}`;
    }

    cql += '\n';

    for (const stmt of this._statements) {
      const built = stmt.build();
      cql += `  ${built.cql};\n`;
      allParams.push(...built.params);
    }

    cql += 'APPLY BATCH';

    this._sealed = true;
    return { cql, params: allParams };
  }
}

// ─── Main CQLBuilder entry point ─────────────────────────────────────────────

class CQLBuilder {
  constructor(registry) {
    if (!(registry instanceof SchemaRegistry)) {
      throw new Error('CQLBuilder requires a SchemaRegistry instance');
    }
    this._registry = registry;
  }

  select(keyspace, table) {
    return new SelectBuilder(this._registry, keyspace, table);
  }

  insert(keyspace, table) {
    return new InsertBuilder(this._registry, keyspace, table);
  }

  update(keyspace, table) {
    return new UpdateBuilder(this._registry, keyspace, table);
  }

  delete(keyspace, table) {
    return new DeleteBuilder(this._registry, keyspace, table);
  }

  batch(type = 'LOGGED') {
    return new BatchBuilder(type);
  }

  validateRawCQL(cql) {
    const errors = [];
    const trimmed = cql.trim().replace(/;$/, '');
    const upper = trimmed.toUpperCase();

    try {
      if (upper.startsWith('SELECT')) {
        this._validateRawSelect(trimmed, errors);
      } else if (upper.startsWith('INSERT')) {
        this._validateRawInsert(trimmed, errors);
      } else if (upper.startsWith('UPDATE')) {
        this._validateRawUpdate(trimmed, errors);
      } else if (upper.startsWith('DELETE')) {
        this._validateRawDelete(trimmed, errors);
      } else {
        errors.push(`Unsupported statement type for validation`);
      }
    } catch (err) {
      errors.push(err.message);
    }

    return { valid: errors.length === 0, errors };
  }

  _parseTableRef(ref) {
    const parts = ref.split('.');
    if (parts.length === 2) return { keyspace: parts[0].trim(), table: parts[1].trim() };
    if (parts.length === 1) return { keyspace: null, table: parts[0].trim() };
    return null;
  }

  _validateRawSelect(cql, errors) {
    const match = cql.match(/SELECT\s+(.+?)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)/i);
    if (!match) {
      errors.push('Could not parse SELECT statement');
      return;
    }
    const colsPart = match[1].trim();
    const tableRef = this._parseTableRef(match[2]);
    if (!tableRef || !tableRef.keyspace) {
      errors.push('Table reference must include keyspace (keyspace.table)');
      return;
    }

    try {
      const tableDef = this._registry.getTable(tableRef.keyspace, tableRef.table);
      if (colsPart !== '*') {
        const cols = colsPart.split(',').map(c => c.trim().replace(/"/g, ''));
        for (const c of cols) {
          if (c === '' || c.toUpperCase() === 'DISTINCT') continue;
          if (!(c in tableDef.columns)) {
            errors.push(`Column "${c}" not found in ${tableRef.keyspace}.${tableRef.table}`);
          }
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  _validateRawInsert(cql, errors) {
    const match = cql.match(/INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(([^)]+)\)/i);
    if (!match) {
      errors.push('Could not parse INSERT statement');
      return;
    }
    const tableRef = this._parseTableRef(match[1]);
    if (!tableRef || !tableRef.keyspace) {
      errors.push('Table reference must include keyspace');
      return;
    }
    try {
      const tableDef = this._registry.getTable(tableRef.keyspace, tableRef.table);
      const cols = match[2].split(',').map(c => c.trim().replace(/"/g, ''));
      for (const c of cols) {
        if (!(c in tableDef.columns)) {
          errors.push(`Column "${c}" not found in ${tableRef.keyspace}.${tableRef.table}`);
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  _validateRawUpdate(cql, errors) {
    const match = cql.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_.]*)/i);
    if (!match) {
      errors.push('Could not parse UPDATE statement');
      return;
    }
    const tableRef = this._parseTableRef(match[1]);
    if (!tableRef || !tableRef.keyspace) {
      errors.push('Table reference must include keyspace');
      return;
    }
    try {
      this._registry.getTable(tableRef.keyspace, tableRef.table);
    } catch (err) {
      errors.push(err.message);
    }
  }

  _validateRawDelete(cql, errors) {
    const match = cql.match(/FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)/i);
    if (!match) {
      errors.push('Could not parse DELETE statement');
      return;
    }
    const tableRef = this._parseTableRef(match[1]);
    if (!tableRef || !tableRef.keyspace) {
      errors.push('Table reference must include keyspace');
      return;
    }
    try {
      this._registry.getTable(tableRef.keyspace, tableRef.table);
    } catch (err) {
      errors.push(err.message);
    }
  }
}

module.exports = { CQLBuilder, CQLBuildError };