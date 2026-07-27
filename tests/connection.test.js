'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  resolveConnection,
  ConnectionError,
  DEFAULT_PORT,
  DEFAULT_DATACENTER,
} = require('../src/connection');

// resolveConnection is pure: options in, config out, no network. The env is
// injected rather than read from process.env so these never depend on whatever
// the developer or CI happens to have exported.
const NO_ENV = {};

describe('resolveConnection — host', () => {
  test('requires a host rather than defaulting to localhost', () => {
    // A localhost default is silently wrong off a dev machine: it turns "nothing
    // configured a host" into ECONNREFUSED 127.0.0.1:9042, which points at the
    // network instead of the configuration.
    assert.throws(
      () => resolveConnection({ user: 'u', pass: 'p' }, NO_ENV),
      (e) => e instanceof ConnectionError && /No Cassandra host/.test(e.message)
    );
  });

  test('accepts a host from the flag', () => {
    const c = resolveConnection({ host: 'db.example', user: 'u', pass: 'p' }, NO_ENV);
    assert.equal(c.host, 'db.example');
  });

  test('accepts a host from the environment', () => {
    const c = resolveConnection({ user: 'u', pass: 'p' }, { CASSANDRA_HOST: 'env.example' });
    assert.equal(c.host, 'env.example');
  });

  test('the flag wins over the environment', () => {
    const c = resolveConnection(
      { host: 'flag.example', user: 'u', pass: 'p' },
      { CASSANDRA_HOST: 'env.example' }
    );
    assert.equal(c.host, 'flag.example');
  });
});

describe('resolveConnection — port and datacenter', () => {
  test('defaults apply when neither flag nor env is set', () => {
    const c = resolveConnection({ host: 'h', user: 'u', pass: 'p' }, NO_ENV);
    assert.equal(c.port, parseInt(DEFAULT_PORT, 10));
    assert.equal(c.datacenter, DEFAULT_DATACENTER);
  });

  test('the environment is consulted before the default', () => {
    // Regression guard: declaring a commander default for these would populate
    // opts whether or not the flag was passed, making the env var unreachable.
    const c = resolveConnection(
      { host: 'h', user: 'u', pass: 'p' },
      { CASSANDRA_PORT: '19042', CASSANDRA_DATACENTER: 'dc-env' }
    );
    assert.equal(c.port, 19042);
    assert.equal(c.datacenter, 'dc-env');
  });

  test('the flag wins over the environment', () => {
    const c = resolveConnection(
      { host: 'h', port: '29042', datacenter: 'dc-flag', user: 'u', pass: 'p' },
      { CASSANDRA_PORT: '19042', CASSANDRA_DATACENTER: 'dc-env' }
    );
    assert.equal(c.port, 29042);
    assert.equal(c.datacenter, 'dc-flag');
  });

  test('port is returned as a number, not a string', () => {
    const c = resolveConnection({ host: 'h', port: '9042', user: 'u', pass: 'p' }, NO_ENV);
    assert.strictEqual(c.port, 9042);
  });

  test('rejects a non-numeric port', () => {
    assert.throws(
      () => resolveConnection({ host: 'h', port: 'abc', user: 'u', pass: 'p' }, NO_ENV),
      (e) => e instanceof ConnectionError && /Invalid Cassandra port/.test(e.message)
    );
  });
});

describe('resolveConnection — authentication', () => {
  test('requires credentials rather than connecting unauthenticated', () => {
    // Falling back to no auth hides a missing credential until the server
    // rejects it, or silently succeeds against a cluster that should have
    // required one.
    assert.throws(
      () => resolveConnection({ host: 'h' }, NO_ENV),
      (e) => e instanceof ConnectionError && /No Cassandra credentials/.test(e.message)
    );
  });

  test('the no-credentials error points at --no-auth', () => {
    // Clusters without auth are legitimate; the message has to say how to
    // express that, or the requirement is just an obstacle.
    assert.throws(
      () => resolveConnection({ host: 'h' }, NO_ENV),
      (e) => /--no-auth/.test(e.message)
    );
  });

  test('rejects a username with no password', () => {
    assert.throws(
      () => resolveConnection({ host: 'h', user: 'u' }, NO_ENV),
      (e) => e instanceof ConnectionError && /password is missing/.test(e.message)
    );
  });

  test('rejects a password with no username', () => {
    assert.throws(
      () => resolveConnection({ host: 'h', pass: 'p' }, NO_ENV),
      (e) => e instanceof ConnectionError && /username is missing/.test(e.message)
    );
  });

  test('accepts credentials from flags', () => {
    const c = resolveConnection({ host: 'h', user: 'u', pass: 'p' }, NO_ENV);
    assert.equal(c.user, 'u');
    assert.equal(c.pass, 'p');
  });

  test('accepts credentials from the environment', () => {
    // The preferred channel: argv is visible in `ps` and echoed by shell tracing.
    const c = resolveConnection(
      { host: 'h' },
      { CASSANDRA_USER: 'envuser', CASSANDRA_PASSWORD: 'envpass' }
    );
    assert.equal(c.user, 'envuser');
    assert.equal(c.pass, 'envpass');
  });

  test('flags win over the environment for credentials', () => {
    const c = resolveConnection(
      { host: 'h', user: 'flaguser', pass: 'flagpass' },
      { CASSANDRA_USER: 'envuser', CASSANDRA_PASSWORD: 'envpass' }
    );
    assert.equal(c.user, 'flaguser');
    assert.equal(c.pass, 'flagpass');
  });

  test('flags and env may be mixed', () => {
    const c = resolveConnection({ host: 'h', user: 'flaguser' }, { CASSANDRA_PASSWORD: 'envpass' });
    assert.equal(c.user, 'flaguser');
    assert.equal(c.pass, 'envpass');
  });
});

describe('resolveConnection — --no-auth', () => {
  // commander maps `--no-auth` to auth === false, and leaves it true otherwise.
  test('connects with no credentials when explicitly requested', () => {
    const c = resolveConnection({ host: 'h', auth: false }, NO_ENV);
    assert.equal(c.user, null);
    assert.equal(c.pass, null);
    assert.equal(c.host, 'h');
  });

  test('still requires a host', () => {
    assert.throws(
      () => resolveConnection({ auth: false }, NO_ENV),
      (e) => e instanceof ConnectionError && /No Cassandra host/.test(e.message)
    );
  });

  test('rejects --no-auth combined with credentials', () => {
    assert.throws(
      () => resolveConnection({ host: 'h', auth: false, user: 'u', pass: 'p' }, NO_ENV),
      (e) => e instanceof ConnectionError && /contradictory/.test(e.message)
    );
  });

  test('rejects --no-auth when credentials come from the environment', () => {
    // Otherwise an exported CASSANDRA_PASSWORD from unrelated work would be
    // silently ignored, and the operator would believe it was in use.
    assert.throws(
      () => resolveConnection(
        { host: 'h', auth: false },
        { CASSANDRA_USER: 'envuser', CASSANDRA_PASSWORD: 'envpass' }
      ),
      (e) => e instanceof ConnectionError && /contradictory/.test(e.message)
    );
  });

  test('auth defaulting to true does not by itself satisfy the credential check', () => {
    assert.throws(
      () => resolveConnection({ host: 'h', auth: true }, NO_ENV),
      (e) => e instanceof ConnectionError && /No Cassandra credentials/.test(e.message)
    );
  });
});

describe('resolveConnection — error quality', () => {
  test('every failure is a ConnectionError, distinguishable from a network error', () => {
    // The CLI reports configuration mistakes and unreachable clusters
    // differently, which depends on this being a distinct type.
    const cases = [
      [{}, {}],
      [{ host: 'h' }, {}],
      [{ host: 'h', user: 'u' }, {}],
      [{ host: 'h', port: 'abc', user: 'u', pass: 'p' }, {}],
      [{ host: 'h', auth: false, user: 'u', pass: 'p' }, {}],
    ];
    for (const [opts, env] of cases) {
      assert.throws(() => resolveConnection(opts, env), ConnectionError,
        `expected ConnectionError for ${JSON.stringify(opts)}`);
    }
  });

  test('messages say what to do, not just what is wrong', () => {
    const cases = [
      [{}, /--host|CASSANDRA_HOST/],
      [{ host: 'h' }, /CASSANDRA_USER|--user/],
      [{ host: 'h', user: 'u' }, /Supply both|--no-auth/],
    ];
    for (const [opts, pattern] of cases) {
      assert.throws(() => resolveConnection(opts, NO_ENV), pattern);
    }
  });
});
