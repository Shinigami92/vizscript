import type { DataType } from '@vizscript/core';
import { arrayOf } from '@vizscript/core';
import type { TypeRef } from './ast';

/** Element types of Godot's packed arrays. */
const PACKED_ARRAYS: Record<string, DataType> = {
  PackedByteArray: 'number',
  PackedInt32Array: 'number',
  PackedInt64Array: 'number',
  PackedFloat32Array: 'number',
  PackedFloat64Array: 'number',
  PackedStringArray: 'string',
  PackedVector2Array: 'Vector2',
  PackedVector3Array: 'Vector3',
  PackedVector4Array: 'Vector4',
  PackedColorArray: 'Color',
};

/** Maps a GDScript type to a pin type (colors and compatibility). */
export function dataTypeOf(ref: TypeRef | string | undefined): DataType {
  const name = typeof ref === 'string' ? ref : ref?.name;
  if (!name) {
    return 'any';
  }

  if (name === 'int' || name === 'float') {
    return 'number';
  }

  if (name === 'String' || name === 'StringName' || name === 'NodePath') {
    return 'string';
  }

  if (name === 'bool') {
    return 'bool';
  }

  if (name === 'void') {
    return 'void';
  }

  if (name === 'Variant') {
    return 'any';
  }

  if (name === 'Callable') {
    return 'function';
  }

  const typed = name.match(/^Array\[(.+)\]$/);
  if (typed) {
    return arrayOf(dataTypeOf(typed[1]));
  }

  const packed = PACKED_ARRAYS[name];
  if (packed) {
    return arrayOf(packed);
  }

  if (/^(Array|Packed\w+Array)\b/.test(name)) {
    return 'array';
  }

  if (/^Dictionary\b/.test(name)) {
    return 'object';
  }

  return name;
}
