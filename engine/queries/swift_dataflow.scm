;; Swift dataflow queries — minimal: reads + scope + async.
;; tree-sitter-swift 0.7 — unusual AST; Write patterns TBD.

;; All identifiers — engine filters to reads
(simple_identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn

;; Async triggers
(await_expression (call_expression) @trigger_call)

;; Sequences
(call_expression) @sequence
