import isBinaryObject from './isBinaryObject';
import cloneBinaryObject from './cloneBinaryObject';
import isPlainObject from './isPlainObject';

function clone(object) {
  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    return object.map(item => clone(item));
  }

  // Special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date && isFinite(object)) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  if (!isPlainObject(object)) {
    return object; // don't clone objects like Workers
  }

  const newObject = {};
  for (const key of Object.keys(object)) {
    const value = clone(object[key]);
    if (typeof value !== 'undefined') {
      newObject[key] = value;
    }
  }
  return newObject;
}

export default clone;