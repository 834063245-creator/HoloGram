;; Zig dataflow queries

;; Writes
(assignment_statement left: (identifier) @write)
(variable_declaration name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn

;; Sequences
(call_expression) @sequence
