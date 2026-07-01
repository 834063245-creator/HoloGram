;; Scala dataflow queries

;; Writes
(assignment_expression left: (identifier) @write)
(val_definition pattern: (identifier) @write)
(var_definition pattern: (identifier) @write)
(val_declaration name: (identifier) @write)
(var_declaration name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn
(method_definition) @scope_fn
(lambda_expression) @scope_fn

;; Sequences
(call_expression) @sequence
