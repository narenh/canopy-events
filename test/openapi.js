// openapi.yaml, loaded for the tests: every JSON answer from /api/v1 is
// checked against the schema the spec gives for that operation and
// status (harness.js runs checkResponse on all of them), so the spec
// can't quietly drift from what the server says. An answer with a status
// the operation doesn't list fails too.
//
// OpenAPI 3.1's schemas are JSON Schema 2020-12, so ajv's 2020 build
// checks them as they are. The whole document is added to ajv under the
// name "openapi", and each response's schema is found by its JSON pointer
// into it, so the spec's own $refs resolve.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const SPEC_FILE = path.join(__dirname, '..', 'openapi.yaml');
const spec = YAML.parse(fs.readFileSync(SPEC_FILE, 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'openapi');

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function escape(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Every operation: { method, path, regex, op, pointer }.
const operations = [];
for (const [p, item] of Object.entries(spec.paths)) {
  const regex = new RegExp('^' + p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$');
  for (const method of METHODS) {
    if (item[method]) operations.push({ method, path: p, regex, op: item[method], pointer: `/paths/${escape(p)}/${method}` });
  }
}

function findOperation(method, url) {
  const pathname = new URL(url, 'http://x').pathname;
  return operations.find((o) => o.method === method.toLowerCase() && o.regex.test(pathname)) || null;
}

// A local $ref ('#/components/...') -> [the object, its pointer].
function resolve(obj, pointer) {
  if (!obj || !obj.$ref) return [obj, pointer];
  const ref = obj.$ref.replace(/^#/, '');
  const target = ref.split('/').slice(1).reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  return resolve(target, ref);
}

const validators = new Map();
function validatorFor(pointer) {
  if (!validators.has(pointer)) validators.set(pointer, ajv.getSchema(`openapi#${pointer}`));
  return validators.get(pointer);
}

// Throws when `body` (JSON) isn't what the spec says `method url` answers
// with `status`.
function checkResponse({ method, url, status, data }) {
  const found = findOperation(method, url);
  if (!found) {
    // The catch-all for unknown endpoints is the only answer allowed
    // outside the spec.
    if (status === 404 && data && data.reason === 'not_found') return;
    throw new Error(`${method} ${url} isn't in openapi.yaml`);
  }
  const responses = found.op.responses || {};
  const raw = responses[String(status)];
  if (!raw) throw new Error(`${method} ${url} answered ${status}, which openapi.yaml doesn't list for ${found.method.toUpperCase()} ${found.path}`);
  const [response, responsePointer] = resolve(raw, `${found.pointer}/responses/${status}`);
  if (!response.content || !response.content['application/json']) {
    throw new Error(`${method} ${url} answered JSON with ${status}, which openapi.yaml doesn't give a JSON schema`);
  }
  const validate = validatorFor(`${responsePointer}/content/${escape('application/json')}/schema`);
  if (!validate(data)) {
    throw new Error(`${method} ${url} (${status}) doesn't match openapi.yaml:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\n${JSON.stringify(data).slice(0, 2000)}`);
  }
}

module.exports = { spec, ajv, operations, findOperation, checkResponse, resolve, escape, SPEC_FILE };
