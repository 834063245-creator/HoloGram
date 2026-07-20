;; Go dataflow queries

;; Writes
;; short_var_declaration: x := ... (left = expression_list)
(short_var_declaration left: (expression_list (identifier) @write))
;; var x T = ...
(var_spec name: (identifier) @write)
;; for k, v := range ...
(range_clause (identifier) @write)

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
