import type { DataType } from './DataType';

export interface Parameter {
  name: string;
  type: DataType;
  required?: boolean;
}
