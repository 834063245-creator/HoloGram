;; C# dataflow queries

;; Writes
(assignment_expression left: (identifier) @write)
(variable_declarator name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(method_declaration) @scope_fn
(constructor_declaration) @scope_fn
(lambda_expression) @scope_fn

;; Async triggers
(await_expression (invocation_expression) @trigger_call)

;; Sequences
(invocation_expression) @sequence
