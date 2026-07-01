;; Go dataflow queries

;; Writes
(short_var_declaration left: (identifier) @write)
(assignment_statement left: (identifier) @write)
(var_spec name: (identifier) @write)
(range_clause left: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(method_declaration) @scope_fn
(func_literal) @scope_fn

;; Sequences
(call_expression) @sequence

;; Goroutine triggers
(go_statement) @trigger_call
