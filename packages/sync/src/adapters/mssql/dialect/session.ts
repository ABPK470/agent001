/**
 * Session options pinned on every diff query so pooled TDS connections
 * produce byte-identical CONVERT() output. Order matters — LANGUAGE resets
 * DATEFORMAT, so DATEFORMAT must come second.
 */

export const MSSQL_DETERMINISTIC_SESSION_PREFIX =
  "SET LANGUAGE us_english; " +
  "SET DATEFORMAT ymd; " +
  "SET NUMERIC_ROUNDABORT OFF; " +
  "SET ANSI_WARNINGS ON; " +
  "SET ANSI_PADDING ON; " +
  "SET ANSI_NULLS ON; " +
  "SET CONCAT_NULL_YIELDS_NULL ON; " +
  "SET ARITHABORT ON; " +
  "SET QUOTED_IDENTIFIER ON; "
