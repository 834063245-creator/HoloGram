;; JS/TS dataflow queries

;; Writes
(assignment_expression left: (identifier) @write)
(augmented_assignment_expression left: (identifier) @write)
(variable_declarator name: (identifier) @write)

;; Async triggers
(await_expression (call_expression) @trigger_call)
(await_expression (identifier) @trigger_call)

;; .then()/.catch() callbacks
(call_expression
  function: (member_expression
    property: (property_identifier) @_then_name)
  arguments: (arguments (identifier) @await_cb))
(call_expression
  function: (member_expression
    property: (property_identifier) @_then_name)
  arguments: (arguments (arrow_function) @await_fn))

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(function_expression) @scope_fn
(arrow_function) @scope_fn
(method_definition) @scope_fn
(generator_function_declaration) @scope_fn
(class_declaration) @scope_class

;; Sequences — consecutive calls
(call_expression) @sequence
