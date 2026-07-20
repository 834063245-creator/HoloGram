;; Swift dataflow queries
;; tree-sitter-swift 0.7

;; Writes
;; x = ...  /  x += ...
(assignment target: (directly_assignable_expression (simple_identifier) @write))
;; let x = ...  /  var x = ...
(pattern bound_identifier: (simple_identifier) @write)
;; var x: Int = ... (property declarations)
(property_declaration name: (pattern bound_identifier: (simple_identifier) @write))

;; All identifiers — engine filters to reads
(simple_identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(lambda_literal) @scope_fn

;; Async triggers
(await_expression (call_expression) @trigger_call)

;; Sequences
(call_expression) @sequence
