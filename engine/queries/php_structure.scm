;; PHP Structure Queries

(method_declaration) @fn
(function_definition) @fn
(arrow_function) @fn
(class_declaration) @class
(interface_declaration) @interface
(trait_declaration) @interface
(function_call_expression) @call
(member_call_expression) @call
(scoped_call_expression) @call
(object_creation_expression) @call
(nullsafe_member_call_expression) @call

;; ── Variables ──
(expression_statement) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Throws ──
(throw_expression) @throws

;; ── Usage ──
(identifier) @usage
