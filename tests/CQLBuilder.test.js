const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SchemaRegistry } = require('../src/SchemaRegistry');
const { CQLBuilder, CQLBuildError, CQLFunction } = require('../src/CQLBuilder');

describe('CQLBuilder', () => {
  let registry;
  let cql;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    cql = new CQLBuilder(registry);
  });

  // ── SELECT ──

  describe('SELECT', () => {
    it('builds a basic SELECT *', () => {
      const q = cql.select('ecommerce', 'users').build();
      assert.equal(q.cql, 'SELECT * FROM ecommerce.users');
      assert.deepEqual(q.params, []);
    });

    it('builds SELECT with specific columns', () => {
      const q = cql.select('ecommerce', 'users')
        .columns('user_id', 'email', 'name')
        .build();
      assert.equal(q.cql, 'SELECT user_id, email, name FROM ecommerce.users');
    });

    it('builds SELECT with WHERE', () => {
      const q = cql.select('ecommerce', 'users')
        .columns('email', 'name')
        .where('user_id', 'some-uuid')
        .build();
      assert.equal(q.cql, 'SELECT email, name FROM ecommerce.users WHERE user_id = ?');
      assert.deepEqual(q.params, ['some-uuid']);
    });

    it('builds SELECT with multiple WHERE conditions', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .where('order_id', '>', 'some-timeuuid')
        .build();
      assert.match(q.cql, /WHERE user_id = \? AND order_id > \?/);
      assert.deepEqual(q.params, ['uid-1', 'some-timeuuid']);
    });

    it('builds SELECT with ORDER BY on clustering column', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .orderBy('order_id', 'DESC')
        .build();
      assert.match(q.cql, /ORDER BY order_id DESC/);
    });

    it('rejects ORDER BY on non-clustering column', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').orderBy('email'),
        CQLBuildError
      );
    });

    it('builds SELECT with LIMIT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .limit(10)
        .build();
      assert.match(q.cql, /LIMIT 10$/);
    });

    it('builds SELECT with PER PARTITION LIMIT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .perPartitionLimit(5)
        .limit(100)
        .build();
      assert.match(q.cql, /PER PARTITION LIMIT 5 LIMIT 100/);
    });

    it('builds SELECT with ALLOW FILTERING', () => {
      const q = cql.select('ecommerce', 'users')
        .where('email', 'test@example.com')
        .allowFiltering()
        .build();
      assert.match(q.cql, /ALLOW FILTERING$/);
    });

    it('builds SELECT DISTINCT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .distinct()
        .columns('user_id')
        .build();
      assert.match(q.cql, /^SELECT DISTINCT user_id/);
    });

    it('builds SELECT with IN operator', () => {
      const q = cql.select('ecommerce', 'users')
        .where('user_id', 'IN', ['id1', 'id2', 'id3'])
        .build();
      assert.match(q.cql, /user_id IN \?/);
      assert.deepEqual(q.params, [['id1', 'id2', 'id3']]);
    });

    it('rejects unknown column in select', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').columns('nonexistent'),
        CQLBuildError
      );
    });

    it('rejects unknown column in where', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').where('ghost', 'val'),
        CQLBuildError
      );
    });

    it('rejects unknown table', () => {
      assert.throws(
        () => cql.select('ecommerce', 'fake_table'),
        /not found/
      );
    });
  });

  // ── INSERT ──

  describe('INSERT', () => {
    it('builds a basic INSERT', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({
          user_id: 'uid-1',
          email: 'a@b.com',
          name: 'Alice',
        })
        .build();
      assert.match(q.cql, /^INSERT INTO ecommerce\.users/);
      assert.match(q.cql, /VALUES \(\?, \?, \?\)/);
      assert.equal(q.params.length, 3);
    });

    it('rejects INSERT missing primary key', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').value('email', 'a@b.com').build(),
        /missing primary key/
      );
    });

    it('builds INSERT with TTL', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ttl(3600)
        .build();
      assert.match(q.cql, /USING TTL 3600/);
    });

    it('builds INSERT with IF NOT EXISTS', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ifNotExists()
        .build();
      assert.match(q.cql, /IF NOT EXISTS/);
    });

    it('builds INSERT with TIMESTAMP', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1' })
        .timestamp(1234567890)
        .build();
      assert.match(q.cql, /TIMESTAMP 1234567890/);
    });

    it('builds INSERT for table with composite primary key', () => {
      const q = cql.insert('ecommerce', 'orders_by_status')
        .values({
          status: 'pending',
          order_date: '2024-01-15',
          order_id: 'timeuuid-1',
          user_id: 'uid-1',
          total_cents: 9999,
        })
        .build();
      assert.match(q.cql, /INSERT INTO ecommerce\.orders_by_status/);
      assert.equal(q.params.length, 5);
    });

    it('rejects unknown column', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').value('nonexistent', 'val'),
        CQLBuildError
      );
    });
  });

  // ── UPDATE ──

  describe('UPDATE', () => {
    it('builds a basic UPDATE', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@email.com')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /^UPDATE ecommerce\.users SET email = \? WHERE user_id = \?/);
      assert.deepEqual(q.params, ['new@email.com', 'uid-1']);
    });

    it('builds UPDATE with multiple sets', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@email.com')
        .set('name', 'Bob')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET email = \?, name = \?/);
      assert.equal(q.params.length, 3); // 2 set values + 1 where value
    });

    it('builds UPDATE with setAll', () => {
      const q = cql.update('ecommerce', 'users')
        .setAll({ email: 'e@e.com', name: 'Eve' })
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET email = \?, name = \?/);
    });

    it('rejects SET on primary key column', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').set('user_id', 'new-id').where('user_id', 'old-id'),
        CQLBuildError
      );
    });

    it('builds UPDATE with IF EXISTS', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@e.com')
        .where('user_id', 'uid-1')
        .ifExists()
        .build();
      assert.match(q.cql, /IF EXISTS$/);
    });

    it('builds UPDATE with IF condition (LWT)', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@e.com')
        .where('user_id', 'uid-1')
        .if_('email', 'old@e.com')
        .build();
      assert.match(q.cql, /IF email = \?/);
    });

    it('builds UPDATE with TTL', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'e@e.com')
        .where('user_id', 'uid-1')
        .ttl(7200)
        .build();
      assert.match(q.cql, /USING TTL 7200/);
    });

    it('rejects UPDATE without WHERE', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').set('email', 'x').build(),
        /WHERE/
      );
    });

    it('rejects UPDATE without SET', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').where('user_id', 'uid-1').build(),
        /SET/
      );
    });

    it('rejects UPDATE missing primary key in WHERE', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users')
          .set('name', 'test')
          .where('email', 'x@x.com')
          .build(),
        /primary key/
      );
    });

    it('builds UPDATE with set add operation', () => {
      const q = cql.update('ecommerce', 'users')
        .addToSet('tags', new Set(['vip']))
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /tags = tags \+ \?/);
    });

    it('builds UPDATE with set remove operation', () => {
      const q = cql.update('ecommerce', 'users')
        .removeFromSet('tags', new Set(['old-tag']))
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /tags = tags - \?/);
    });

    it('builds UPDATE with map put', () => {
      const q = cql.update('ecommerce', 'users')
        .putToMap('preferences', 'theme', 'dark')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /preferences\[\?\] = \?/);
      assert.deepEqual(q.params, ['theme', 'dark', 'uid-1']);
    });

    it('builds UPDATE with list append', () => {
      const q = cql.update('ecommerce', 'orders_by_user')
        .appendToList('items', ['new-item'])
        .where('user_id', 'uid-1')
        .where('order_id', 'tid-1')
        .build();
      assert.match(q.cql, /items = items \+ \?/);
    });

    it('rejects collection op on wrong type', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').addToSet('email', 'val'),
        /set<.+>/
      );
      assert.throws(
        () => cql.update('ecommerce', 'users').appendToList('email', ['val']),
        /list<.+>/
      );
      assert.throws(
        () => cql.update('ecommerce', 'users').putToMap('email', 'k', 'v'),
        /map<.+>/
      );
    });
  });

  // ── DELETE ──

  describe('DELETE', () => {
    it('builds a basic DELETE', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .build();
      assert.equal(q.cql, 'DELETE FROM ecommerce.users WHERE user_id = ?');
      assert.deepEqual(q.params, ['uid-1']);
    });

    it('builds DELETE with specific columns', () => {
      const q = cql.delete('ecommerce', 'users')
        .columns('tags', 'preferences')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /^DELETE tags, preferences FROM/);
    });

    it('builds DELETE with IF EXISTS', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .ifExists()
        .build();
      assert.match(q.cql, /IF EXISTS$/);
    });

    it('builds DELETE with IF condition', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .if_('email', 'old@e.com')
        .build();
      assert.match(q.cql, /IF email = \?/);
    });

    it('builds DELETE with TIMESTAMP', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .timestamp(1234567890)
        .build();
      assert.match(q.cql, /USING TIMESTAMP 1234567890/);
    });

    it('rejects DELETE without WHERE', () => {
      assert.throws(
        () => cql.delete('ecommerce', 'users').build(),
        /WHERE/
      );
    });

    it('rejects unknown column', () => {
      assert.throws(
        () => cql.delete('ecommerce', 'users').where('nonexistent', 'val'),
        CQLBuildError
      );
    });
  });

  // ── BATCH ──

  describe('BATCH', () => {
    it('builds a LOGGED BATCH', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const upd = cql.update('ecommerce', 'products')
        .set('in_stock', true)
        .where('product_id', 'pid-1');

      const q = cql.batch().add(ins).add(upd).build();
      assert.match(q.cql, /^BEGIN BATCH/);
      assert.match(q.cql, /INSERT INTO/);
      assert.match(q.cql, /UPDATE/);
      assert.match(q.cql, /APPLY BATCH$/);
    });

    it('builds an UNLOGGED BATCH', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const q = cql.batch('UNLOGGED').add(ins).build();
      assert.match(q.cql, /^BEGIN UNLOGGED BATCH/);
    });

    it('builds BATCH with TIMESTAMP', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const q = cql.batch().add(ins).timestamp(999).build();
      assert.match(q.cql, /USING TIMESTAMP 999/);
    });

    it('rejects empty batch', () => {
      assert.throws(() => cql.batch().build(), /at least one/);
    });

    it('collects all params from batch statements', () => {
      const ins1 = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const ins2 = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-2', email: 'c@d.com' });

      const q = cql.batch().add(ins1).add(ins2).build();
      assert.equal(q.params.length, 4);
    });
  });

  // ── Raw CQL validation ──

  describe('validateRawCQL', () => {
    it('validates correct SELECT', () => {
      const r = cql.validateRawCQL('SELECT user_id, email FROM ecommerce.users');
      assert.ok(r.valid);
    });

    it('catches invalid column in SELECT', () => {
      const r = cql.validateRawCQL('SELECT user_id, fake_col FROM ecommerce.users');
      assert.ok(!r.valid);
      assert.ok(r.errors.some(e => e.includes('fake_col')));
    });

    it('catches invalid table in SELECT', () => {
      const r = cql.validateRawCQL('SELECT * FROM ecommerce.nonexistent');
      assert.ok(!r.valid);
    });

    it('validates correct INSERT', () => {
      const r = cql.validateRawCQL(
        "INSERT INTO ecommerce.users (user_id, email) VALUES ('uid', 'a@b.com')"
      );
      assert.ok(r.valid);
    });

    it('catches invalid column in INSERT', () => {
      const r = cql.validateRawCQL(
        "INSERT INTO ecommerce.users (user_id, fake) VALUES ('uid', 'val')"
      );
      assert.ok(!r.valid);
    });
  });

  // ── TTL = 0 ──

  describe('TTL=0 support', () => {
    it('INSERT accepts ttl(0) and produces USING TTL 0', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ttl(0)
        .build();
      assert.match(q.cql, /USING TTL 0/);
    });

    it('UPDATE accepts ttl(0) and produces USING TTL 0', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@e.com')
        .where('user_id', 'uid-1')
        .ttl(0)
        .build();
      assert.match(q.cql, /USING TTL 0/);
    });

    it('INSERT still rejects negative TTL', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').values({ user_id: 'uid-1' }).ttl(-1),
        /non-negative/
      );
    });

    it('UPDATE still rejects negative TTL', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').set('email', 'x').where('user_id', 'uid-1').ttl(-5),
        /non-negative/
      );
    });

    it('still rejects non-integer TTL', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').values({ user_id: 'uid-1' }).ttl(3.5),
        /non-negative integer/
      );
    });

    it('positive TTL still works normally', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ttl(3600)
        .build();
      assert.match(q.cql, /USING TTL 3600/);
    });
  });

  // ── UDT subfield updates ──

  describe('UDT setField', () => {
    // The ecommerce schema has frozen<address> — setField must reject it.
    // For success-path tests, we need a non-frozen UDT column.
    let nfRegistry, nfCql;
    beforeEach(() => {
      nfRegistry = new SchemaRegistry();
      nfRegistry.register({
        keyspace: 'test_nf',
        replication: { class: 'SimpleStrategy', replication_factor: 1 },
        types: {
          contact_info: {
            fields: { phone: 'text', city: 'text', zip: 'text' },
          },
        },
        tables: {
          accounts: {
            columns: {
              account_id: 'uuid',
              email: 'text',
              contact: 'contact_info',
            },
            partition_key: ['account_id'],
          },
        },
      });
      nfCql = new CQLBuilder(nfRegistry);
    });

    it('builds SET contact.city = ? for non-frozen UDT', () => {
      const q = nfCql.update('test_nf', 'accounts')
        .setField('contact', 'city', 'NYC')
        .where('account_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET contact\.city = \?/);
      assert.deepEqual(q.params, ['NYC', 'uid-1']);
    });

    it('builds SET with multiple UDT subfields', () => {
      const q = nfCql.update('test_nf', 'accounts')
        .setField('contact', 'city', 'NYC')
        .setField('contact', 'zip', '10001')
        .where('account_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET contact\.city = \?, contact\.zip = \?/);
      assert.deepEqual(q.params, ['NYC', '10001', 'uid-1']);
    });

    it('can mix setField with regular set', () => {
      const q = nfCql.update('test_nf', 'accounts')
        .set('email', 'new@e.com')
        .setField('contact', 'phone', '555-1234')
        .where('account_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET email = \?, contact\.phone = \?/);
      assert.deepEqual(q.params, ['new@e.com', '555-1234', 'uid-1']);
    });

    it('rejects setField on frozen UDT column', () => {
      // ecommerce.users.address is frozen<address>
      assert.throws(
        () => cql.update('ecommerce', 'users')
          .setField('address', 'city', 'NYC'),
        /frozen UDT/
      );
    });

    it('rejects invalid UDT field name', () => {
      assert.throws(
        () => nfCql.update('test_nf', 'accounts')
          .setField('contact', 'nonexistent_field', 'val'),
        /not found in UDT/
      );
    });

    it('rejects setField on non-UDT column', () => {
      assert.throws(
        () => nfCql.update('test_nf', 'accounts')
          .setField('email', 'something', 'val'),
        /not found in keyspace/
      );
    });

    it('rejects setField on non-existent column', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users')
          .setField('ghost_column', 'field', 'val'),
        /does not exist/
      );
    });
  });

  // ── CQLFunction (whitelisted server-side functions) ──

  describe('CQLFunction', () => {
    describe('whitelist validation', () => {
      it('accepts known function: now', () => {
        const fn = CQLBuilder.fn('now');
        assert.ok(fn instanceof CQLFunction);
      });

      it('accepts known function: uuid', () => {
        assert.ok(CQLBuilder.fn('uuid') instanceof CQLFunction);
      });

      it('accepts known function: toTimestamp', () => {
        assert.ok(CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')) instanceof CQLFunction);
      });

      it('rejects unknown function names', () => {
        assert.throws(() => CQLBuilder.fn('DROP'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('DELETE'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('eval'), CQLBuildError);
      });

      it('rejects empty function name', () => {
        assert.throws(() => CQLBuilder.fn(''), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('  '), CQLBuildError);
      });

      it('rejects non-string function name', () => {
        assert.throws(() => CQLBuilder.fn(123), CQLBuildError);
        assert.throws(() => CQLBuilder.fn(null), CQLBuildError);
      });

      it('rejects SQL injection attempts via function name', () => {
        assert.throws(() => CQLBuilder.fn('now(); DROP TABLE users; --'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('toTimestamp(now())'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn("'); DROP KEYSPACE test; --"), CQLBuildError);
      });
    });

    describe('CQL rendering', () => {
      it('renders now() with no args and no params', () => {
        const fn = CQLBuilder.fn('now');
        const params = [];
        assert.equal(fn.toCQL(params), 'now()');
        assert.deepEqual(params, []);
      });

      it('renders toTimestamp(now()) via nesting', () => {
        const fn = CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now'));
        const params = [];
        assert.equal(fn.toCQL(params), 'toTimestamp(now())');
        assert.deepEqual(params, []);
      });

      it('parameterizes primitive args as ?', () => {
        const fn = CQLBuilder.fn('minTimeuuid', '2024-01-01');
        const params = [];
        assert.equal(fn.toCQL(params), 'minTimeuuid(?)');
        assert.deepEqual(params, ['2024-01-01']);
      });

      it('renders token() with mixed args', () => {
        const fn = CQLBuilder.fn('token', 'partition_val');
        const params = [];
        assert.equal(fn.toCQL(params), 'token(?)');
        assert.deepEqual(params, ['partition_val']);
      });
    });

    describe('in INSERT values', () => {
      it('uses now() in INSERT without adding to params', () => {
        const q = cql.insert('ecommerce', 'orders_by_user')
          .values({
            user_id: 'uid-1',
            order_id: CQLBuilder.fn('now'),
            status: 'pending',
            total_cents: 999,
            created_at: CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')),
          })
          .build();
        assert.match(q.cql, /VALUES \(\?, now\(\), \?, \?, toTimestamp\(now\(\)\)\)/);
        assert.deepEqual(q.params, ['uid-1', 'pending', 999]);
      });

      it('uses uuid() in INSERT', () => {
        const q = cql.insert('ecommerce', 'users')
          .values({
            user_id: CQLBuilder.fn('uuid'),
            email: 'a@b.com',
          })
          .build();
        assert.match(q.cql, /VALUES \(uuid\(\), \?\)/);
        assert.deepEqual(q.params, ['a@b.com']);
      });

      it('mixes function and regular values correctly', () => {
        const q = cql.insert('ecommerce', 'users')
          .values({
            user_id: 'uid-1',
            email: 'a@b.com',
            created_at: CQLBuilder.fn('currentTimestamp'),
          })
          .build();
        assert.match(q.cql, /\?, \?, currentTimestamp\(\)/);
        assert.deepEqual(q.params, ['uid-1', 'a@b.com']);
      });
    });

    describe('in UPDATE SET', () => {
      it('uses currentTimestamp() in UPDATE SET', () => {
        const q = cql.update('ecommerce', 'users')
          .set('updated_at', CQLBuilder.fn('currentTimestamp'))
          .where('user_id', 'uid-1')
          .build();
        assert.match(q.cql, /SET updated_at = currentTimestamp\(\)/);
        assert.deepEqual(q.params, ['uid-1']);
      });

      it('mixes function and regular SET values', () => {
        const q = cql.update('ecommerce', 'users')
          .set('email', 'new@e.com')
          .set('updated_at', CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')))
          .where('user_id', 'uid-1')
          .build();
        assert.match(q.cql, /SET email = \?, updated_at = toTimestamp\(now\(\)\)/);
        assert.deepEqual(q.params, ['new@e.com', 'uid-1']);
      });
    });

    describe('with parameterized function arguments', () => {
      it('parameterizes primitive args inside a function in SET', () => {
        const q = cql.update('ecommerce', 'users')
          .set('created_at', CQLBuilder.fn('toTimestamp', CQLBuilder.fn('minTimeuuid', '2024-01-01')))
          .where('user_id', 'uid-1')
          .build();
        assert.match(q.cql, /SET created_at = toTimestamp\(minTimeuuid\(\?\)\)/);
        assert.deepEqual(q.params, ['2024-01-01', 'uid-1']);
      });
    });

    describe('security edge cases', () => {
      it('cannot inject CQL via primitive argument values', () => {
        // Primitive args become parameterized ?, so injection strings are just data
        const fn = CQLBuilder.fn('minTimeuuid', "'; DROP TABLE users; --");
        const params = [];
        const result = fn.toCQL(params);
        assert.equal(result, 'minTimeuuid(?)');
        assert.deepEqual(params, ["'; DROP TABLE users; --"]);
      });

      it('function names cannot contain special characters', () => {
        assert.throws(() => CQLBuilder.fn('now()'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('a.b'), CQLBuildError);
        assert.throws(() => CQLBuilder.fn('fn; DROP'), CQLBuildError);
      });

      it('cannot nest unknown functions inside known functions', () => {
        assert.throws(
          () => CQLBuilder.fn('toTimestamp', CQLBuilder.fn('evil')),
          CQLBuildError
        );
      });
    });
  });
});

// ─── TTL/WRITETIME projections + element deletion + raw projection parsing ──

describe('SELECT metadata projections (TTL/WRITETIME)', () => {
  let registry;
  let cql;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    cql = new CQLBuilder(registry);
  });

  it('projects TTL with an alias alongside plain columns', () => {
    const q = cql.select('ecommerce', 'orders_by_user')
      .columns('order_id')
      .ttl('created_at', 'expires_at')
      .where('user_id', 'uid-1')
      .build();
    assert.equal(
      q.cql,
      'SELECT order_id, TTL(created_at) AS expires_at FROM ecommerce.orders_by_user WHERE user_id = ?'
    );
    assert.deepEqual(q.params, ['uid-1']);
  });

  it('projects WRITETIME without an alias', () => {
    const q = cql.select('ecommerce', 'users')
      .writetime('email')
      .where('user_id', 'uid-1')
      .build();
    assert.equal(q.cql, 'SELECT WRITETIME(email) FROM ecommerce.users WHERE user_id = ?');
  });

  it('rejects TTL on a primary key column', () => {
    assert.throws(
      () => cql.select('ecommerce', 'orders_by_user').ttl('order_id'),
      /primary key columns have no cell metadata/
    );
  });

  it('rejects TTL on a non-frozen collection', () => {
    assert.throws(
      () => cql.select('ecommerce', 'users').ttl('tags'),
      /multi-cell/
    );
  });

  it('rejects an unknown column', () => {
    assert.throws(
      () => cql.select('ecommerce', 'users').ttl('nonexistent'),
      CQLBuildError
    );
  });

  it('rejects a malformed alias', () => {
    assert.throws(
      () => cql.select('ecommerce', 'users').ttl('email', 'bad alias; DROP'),
      /Invalid projection alias/
    );
  });

  it('rejects DISTINCT combined with metadata projections', () => {
    assert.throws(
      () => cql.select('ecommerce', 'users').distinct().ttl('email').build(),
      /DISTINCT cannot be combined/
    );
  });

  it('clone() carries metadata projections', () => {
    const base = cql.select('ecommerce', 'users').ttl('email', 'e');
    const q = base.clone().where('user_id', 'u').build();
    assert.match(q.cql, /TTL\(email\) AS e/);
  });
});

describe('DELETE element removal', () => {
  let registry;
  let cql;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    cql = new CQLBuilder(registry);
  });

  it('deletes a map entry by key', () => {
    const q = cql.delete('ecommerce', 'users')
      .element('preferences', 'theme')
      .where('user_id', 'uid-1')
      .build();
    assert.equal(q.cql, 'DELETE preferences[?] FROM ecommerce.users WHERE user_id = ?');
    assert.deepEqual(q.params, ['theme', 'uid-1']);
  });

  it('deletes a list element by index', () => {
    const q = cql.delete('ecommerce', 'orders_by_user')
      .element('items', 0)
      .where('user_id', 'uid-1')
      .where('order_id', 'tuuid-1')
      .build();
    assert.equal(q.cql, 'DELETE items[?] FROM ecommerce.orders_by_user WHERE user_id = ? AND order_id = ?');
    assert.deepEqual(q.params, [0, 'uid-1', 'tuuid-1']);
  });

  it('mixes whole-column and element deletes, element keys bind first in statement order', () => {
    const q = cql.delete('ecommerce', 'users')
      .columns('name')
      .element('preferences', 'theme')
      .where('user_id', 'uid-1')
      .build();
    assert.equal(q.cql, 'DELETE name, preferences[?] FROM ecommerce.users WHERE user_id = ?');
    assert.deepEqual(q.params, ['theme', 'uid-1']);
  });

  it('rejects element deletion on a set (CQL has no set element deletion)', () => {
    assert.throws(
      () => cql.delete('ecommerce', 'users').element('tags', 'vip'),
      /needs a non-frozen map or list/
    );
  });

  it('rejects element deletion on a scalar column', () => {
    assert.throws(
      () => cql.delete('ecommerce', 'users').element('email', 'x'),
      /needs a non-frozen map or list/
    );
  });

  it('clone() carries element deletions', () => {
    const base = cql.delete('ecommerce', 'users').element('preferences', 'theme');
    const q = base.clone().where('user_id', 'u').build();
    assert.match(q.cql, /preferences\[\?\]/);
  });
});

describe('validateRawCQL function projections', () => {
  let registry;
  let cql;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    cql = new CQLBuilder(registry);
  });

  it('accepts TTL(...) AS alias projections on known columns', () => {
    const result = cql.validateRawCQL(
      'SELECT order_id,TTL(created_at) AS expires_at FROM ecommerce.orders_by_user WHERE user_id = ?'
    );
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it('accepts COUNT(*) and aliased plain columns', () => {
    const result = cql.validateRawCQL(
      'SELECT COUNT(*), email AS contact FROM ecommerce.users'
    );
    assert.equal(result.valid, true);
  });

  it('still flags an unknown column inside a function projection', () => {
    const result = cql.validateRawCQL(
      'SELECT TTL(fake_col) FROM ecommerce.users'
    );
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /fake_col/);
  });

  it('does not split on commas inside function arguments', () => {
    const result = cql.validateRawCQL(
      'SELECT minTimeuuid(created_at, email) FROM ecommerce.users'
    );
    // multi-arg functions are beyond raw validation but must not false-positive
    assert.equal(result.valid, true);
  });
});
