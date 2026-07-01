;; Dart dataflow queries — minimal: reads + scope + async only.
;; tree-sitter-dart 0.2 has unusual AST; Write patterns TBD.

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(method_declaration) @scope_fn

;; Async triggers
(await_expression (identifier) @trigger_call)

;; Sequences
(function_expression) @sequence
