CLASS zcl_simple DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS get_value RETURNING VALUE(rv_value) TYPE string.
ENDCLASS.

CLASS zcl_simple IMPLEMENTATION.
  METHOD get_value.
    rv_value = 'hello'.
  ENDMETHOD.
ENDCLASS.
