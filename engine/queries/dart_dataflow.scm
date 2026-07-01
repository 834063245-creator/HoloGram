;; Dart dataflow queries

;; Writes
(assignment_expression left: (identifier) @write)
(variable_declaration name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(method_declaration) @scope_fn
(function_expression) @scope_fn

;; Async triggers
(await_expression (function_expression) @trigger_call)
(await_expression (identifier) @trigger_call)

;; Sequences
(function_expression) @sequence
