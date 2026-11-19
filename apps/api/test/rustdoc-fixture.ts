/** A crate's rustdoc JSON in small (format 57, as docs.rs builds it). */
export const RUSTDOC = {
  root: 0,
  format_version: 57,
  crate_version: '1.2.3',
  index: {
    '0': {
      id: 0,
      name: 'minicrate',
      visibility: 'public',
      inner: { module: { items: [1, 2, 3, 6, 9, 10, 12] } },
    },
    '1': {
      id: 1,
      name: 'parse',
      visibility: 'public',
      inner: {
        function: {
          sig: {
            inputs: [
              [
                'input',
                {
                  borrowed_ref: {
                    lifetime: "'a",
                    is_mutable: false,
                    type: { primitive: 'str' },
                  },
                },
              ],
            ],
            output: {
              resolved_path: {
                path: 'crate::Result',
                id: 9,
                args: {
                  angle_bracketed: {
                    args: [
                      { type: { resolved_path: { path: 'Value', id: 3 } } },
                    ],
                    constraints: [],
                  },
                },
              },
            },
          },
          generics: { params: [], where_predicates: [] },
          header: { is_async: false },
        },
      },
    },
    '2': {
      id: 2,
      name: 'helper',
      visibility: 'crate',
      inner: { function: { sig: { inputs: [], output: null } } },
    },
    '3': {
      id: 3,
      name: 'Value',
      visibility: 'public',
      inner: {
        enum: {
          generics: { params: [] },
          variants: [4, 5],
          impls: [7, 16],
        },
      },
    },
    '4': {
      id: 4,
      name: 'Null',
      visibility: 'default',
      inner: { variant: { kind: 'plain' } },
    },
    '5': {
      id: 5,
      name: 'Text',
      visibility: 'default',
      inner: { variant: { kind: { tuple: [11] } } },
    },
    '11': {
      id: 11,
      name: '0',
      visibility: 'default',
      inner: {
        struct_field: { resolved_path: { path: 'alloc::string::String' } },
      },
    },
    '7': {
      id: 7,
      name: null,
      visibility: 'default',
      inner: {
        impl: {
          trait: null,
          generics: { params: [] },
          items: [8],
          is_synthetic: false,
        },
      },
    },
    '8': {
      id: 8,
      name: 'as_str',
      visibility: 'public',
      inner: {
        function: {
          sig: {
            inputs: [
              [
                'self',
                {
                  borrowed_ref: {
                    is_mutable: false,
                    type: { generic: 'Self' },
                  },
                },
              ],
            ],
            output: {
              resolved_path: {
                path: 'Option',
                args: {
                  angle_bracketed: {
                    args: [
                      {
                        type: {
                          borrowed_ref: {
                            is_mutable: false,
                            type: { primitive: 'str' },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          generics: { params: [] },
        },
      },
    },
    '16': {
      id: 16,
      name: null,
      visibility: 'default',
      inner: {
        impl: { trait: { path: 'Clone' }, items: [], is_synthetic: false },
      },
    },
    '6': {
      id: 6,
      name: 'nested',
      visibility: 'public',
      inner: { module: { items: [13] } },
    },
    '13': {
      id: 13,
      name: null,
      visibility: 'public',
      inner: {
        use: { source: 'crate::parse', name: 'run', id: 1, is_glob: false },
      },
    },
    '9': {
      id: 9,
      name: 'Result',
      visibility: 'public',
      inner: {
        type_alias: {
          type: {
            resolved_path: {
              path: 'core::result::Result',
              args: {
                angle_bracketed: {
                  args: [
                    { type: { generic: 'T' } },
                    { type: { resolved_path: { path: 'Error' } } },
                  ],
                },
              },
            },
          },
          generics: {
            params: [{ name: 'T', kind: { type: { bounds: [] } } }],
          },
        },
      },
    },
    '10': {
      id: 10,
      name: 'MAX',
      visibility: 'public',
      inner: {
        constant: {
          type: { primitive: 'usize' },
          const: { expr: '8', value: null, is_literal: true },
        },
      },
    },
    '12': {
      id: 12,
      name: 'Point',
      visibility: 'public',
      inner: {
        struct: {
          kind: { plain: { fields: [14, 15], has_stripped_fields: false } },
          generics: { params: [] },
          impls: [],
        },
      },
    },
    '14': {
      id: 14,
      name: 'x',
      visibility: 'public',
      inner: { struct_field: { primitive: 'f64' } },
    },
    '15': {
      id: 15,
      name: 'secret',
      visibility: 'crate',
      inner: { struct_field: { primitive: 'u8' } },
    },
  },
};
