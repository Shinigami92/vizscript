import type { ComputedRef, InjectionKey } from 'vue';
import type { ExternalType } from '../../graph/project-index';

/** Types of other files and libraries the type pickers offer. */
export interface TypeChoices {
  types: ComputedRef<ExternalType[]>;
  /** Reads them (once, when a picker opens first). */
  load: () => void;
}

/** Provided by the workspace; pickers without it offer the file's types. */
export const TYPE_CHOICES: InjectionKey<TypeChoices> = Symbol('type-choices');
