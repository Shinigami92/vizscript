export type PrimitiveType = 'string';
export type AnyType = 'any';
export type VoidType = 'void';
export type ComplexType = { name: string };
export type DataType = PrimitiveType | AnyType | VoidType | ComplexType;

export function dataTypeColor(dataType: DataType): string {
  switch (dataType) {
    case 'string':
      return 'purple';
  }
  if (typeof dataType !== 'string') {
    return 'lightblue';
  }
  console.warn('Undefined data-type color found:', dataType, 'Fallback to default color.');
  return 'white';
}
