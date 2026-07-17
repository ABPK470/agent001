/** Per-kind connector brand mark — instances list and Types tab. */

import type { ConnectorKindId } from "@mia/shared-types"
import type { JSX } from "react"

import aqueductIcon from "./brand-icons/aqueduct.svg"
import awsIcon from "./brand-icons/aws.svg"
import azureIcon from "./brand-icons/azure.svg"
import databricksIcon from "./brand-icons/databricks.svg"
import denodoIcon from "./brand-icons/denodo.svg"
import ftpIcon from "./brand-icons/ftp.svg"
import hiveIcon from "./brand-icons/hive.svg"
import httpApiIcon from "./brand-icons/httpApi.svg"
import mssqlIcon from "./brand-icons/mssql.svg"
import postgresIcon from "./brand-icons/postgres.svg"
import webhdfsIcon from "./brand-icons/webhdfs.svg"

const BRAND_ICON_SRC: Record<ConnectorKindId, string> = {
  mssql: mssqlIcon,
  postgres: postgresIcon,
  databricks: databricksIcon,
  azure: azureIcon,
  aws: awsIcon,
  denodo: denodoIcon,
  httpApi: httpApiIcon,
  ftp: ftpIcon,
  aqueduct: aqueductIcon,
  hive: hiveIcon,
  webhdfs: webhdfsIcon,
}

export function ConnectorKindMark({
  kind,
  size = 14,
  className = "",
  title,
}: {
  kind: ConnectorKindId
  size?: number
  className?: string
  title?: string
}): JSX.Element {
  return (
    <img
      src={BRAND_ICON_SRC[kind]}
      width={size}
      height={size}
      alt=""
      title={title}
      className={["shrink-0 object-contain", className].join(" ")}
      aria-hidden={title == null}
    />
  )
}
