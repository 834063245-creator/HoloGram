;; Lua dataflow queries

;; Writes
(assignment_statement variable: (identifier) @write)
(variable_declaration name: (identifier) @write)
(local_variable_declaration name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(function_definition) @scope_fn

;; Sequences
(function_call) @sequence
