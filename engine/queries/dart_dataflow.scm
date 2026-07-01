;; Dart dataflow queries
;; tree-sitter-dart 0.2

;; Writes
;; x = y  /  x += y
(assignment_expression left: (assignable_expression (identifier) @write))
;; var x = 1  /  int x = 1  /  final x = 1
(initialized_variable_definition name: (identifier) @write)
;; Pattern variable declarations (destructuring, switch patterns)
(variable_pattern name: (identifier) @write)
;; static const x = 1
(static_final_declaration name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(method_declaration) @scope_fn
(function_expression) @scope_fn

;; Async triggers
(await_expression (identifier) @trigger_call)

;; Sequences — call expressions
(call_expression) @sequence
