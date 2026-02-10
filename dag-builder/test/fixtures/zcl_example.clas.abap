CLASS zcl_example DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS constructor.
    METHODS process_data
      IMPORTING iv_input TYPE string
      RETURNING VALUE(rv_result) TYPE string.
  PRIVATE SECTION.
    DATA mo_helper TYPE REF TO zcl_custom_helper.
    DATA mo_logger TYPE REF TO cl_standard_logger.
    DATA mt_data TYPE TABLE OF ztable_custom.
ENDCLASS.

CLASS zcl_example IMPLEMENTATION.
  METHOD constructor.
    CREATE OBJECT mo_helper.
    mo_logger = cl_standard_logger=>get_instance( ).
  ENDMETHOD.

  METHOD process_data.
    DATA lo_utils TYPE REF TO zcl_utils.
    CREATE OBJECT lo_utils.
    rv_result = lo_utils->convert( iv_input ).
    mo_helper->validate( rv_result ).
    mo_logger->log( rv_result ).
  ENDMETHOD.
ENDCLASS.
