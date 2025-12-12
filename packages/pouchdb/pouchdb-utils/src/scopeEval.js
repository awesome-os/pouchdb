// This is basically just a wrapper around new Function()
function scopeEval(source, scope) {
  const keys = Object.keys(scope);
  const values = keys.map(key => scope[key]);
  return new Function(...keys, source)(...values);
}

export default scopeEval;
