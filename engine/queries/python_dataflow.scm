;; Python dataflow queries

;; Writes — assignment LHS
(assignment left: (identifier) @write)
(augmented_assignment left: (identifier) @write)
(for_statement left: (identifier) @write)
;; def f(x, y): — parameters
(parameters (identifier) @write)
;; x, y = ... — tuple unpacking LHS
(assignment left: (pattern_list (identifier) @write))

;; Global declaration (explicit shared state)
(global_statement (identifier) @global_var)

;; Async triggers — await f() or await x
(await (call) @trigger_call)
(await (identifier) @trigger_call)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn
(class_definition) @scope_class
(lambda) @scope_fn

;; Sequences — consecutive calls
(call) @sequence
