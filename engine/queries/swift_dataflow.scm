;; Swift dataflow queries

;; Writes
(assignment left: (simple_identifier) @write)
(value_binding_pattern (simple_identifier) @write)

;; All identifiers — engine filters to reads
(simple_identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(method_declaration) @scope_fn
(closure_expression) @scope_fn

;; Async triggers
(await_expression (call_expression) @trigger_call)

;; Sequences
(call_expression) @sequence
