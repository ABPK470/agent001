-- =============================================================
-- Agent001 DWH Test Database — Seed Script
-- Compatible with Azure SQL Edge (no CLR / FORMAT())
-- =============================================================

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'AgentDWH')
  CREATE DATABASE AgentDWH;
GO

USE AgentDWH;
GO

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'dwh')
  EXEC('CREATE SCHEMA dwh');
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'staging')
  EXEC('CREATE SCHEMA staging');
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'meta')
  EXEC('CREATE SCHEMA meta');
GO

-- Drop facts first (FK deps), then dimensions, then staging/meta
IF OBJECT_ID('dwh.FactSales', 'U') IS NOT NULL DROP TABLE dwh.FactSales;
IF OBJECT_ID('dwh.FactInventory', 'U') IS NOT NULL DROP TABLE dwh.FactInventory;
IF OBJECT_ID('dwh.DimDate', 'U') IS NOT NULL DROP TABLE dwh.DimDate;
IF OBJECT_ID('dwh.DimCustomer', 'U') IS NOT NULL DROP TABLE dwh.DimCustomer;
IF OBJECT_ID('dwh.DimProduct', 'U') IS NOT NULL DROP TABLE dwh.DimProduct;
IF OBJECT_ID('dwh.DimStore', 'U') IS NOT NULL DROP TABLE dwh.DimStore;
IF OBJECT_ID('staging.RawSalesImport', 'U') IS NOT NULL DROP TABLE staging.RawSalesImport;
IF OBJECT_ID('meta.ETLJobLog', 'U') IS NOT NULL DROP TABLE meta.ETLJobLog;
IF OBJECT_ID('dwh.vSalesByMonth', 'V') IS NOT NULL DROP VIEW dwh.vSalesByMonth;
IF OBJECT_ID('dwh.vCustomerRevenue', 'V') IS NOT NULL DROP VIEW dwh.vCustomerRevenue;
IF OBJECT_ID('dwh.vProductPerformance', 'V') IS NOT NULL DROP VIEW dwh.vProductPerformance;
GO

-- DIMENSION: Date (2023-2025)
CREATE TABLE dwh.DimDate (
  DateKey        INT          NOT NULL PRIMARY KEY,
  FullDate       DATE         NOT NULL,
  DayOfWeek      TINYINT      NOT NULL,
  DayName        VARCHAR(10)  NOT NULL,
  DayOfMonth     TINYINT      NOT NULL,
  WeekOfYear     TINYINT      NOT NULL,
  MonthNum       TINYINT      NOT NULL,
  MonthName      VARCHAR(10)  NOT NULL,
  Quarter        TINYINT      NOT NULL,
  Year           SMALLINT     NOT NULL,
  IsWeekend      BIT          NOT NULL,
  FiscalQuarter  TINYINT      NOT NULL,
  FiscalYear     SMALLINT     NOT NULL
);
;WITH dates AS (
  SELECT CAST('2023-01-01' AS DATE) AS d
  UNION ALL
  SELECT DATEADD(DAY, 1, d) FROM dates WHERE d < '2025-12-31'
)
INSERT INTO dwh.DimDate
SELECT
  YEAR(d) * 10000 + MONTH(d) * 100 + DAY(d),
  d,
  DATEPART(WEEKDAY, d),
  DATENAME(WEEKDAY, d),
  DAY(d),
  DATEPART(WEEK, d),
  MONTH(d),
  DATENAME(MONTH, d),
  DATEPART(QUARTER, d),
  YEAR(d),
  CASE WHEN DATEPART(WEEKDAY, d) IN (1,7) THEN 1 ELSE 0 END,
  CASE WHEN MONTH(d) <= 3 THEN 4
       WHEN MONTH(d) <= 6 THEN 1
       WHEN MONTH(d) <= 9 THEN 2
       ELSE 3 END,
  CASE WHEN MONTH(d) <= 3 THEN YEAR(d) ELSE YEAR(d) + 1 END
FROM dates
OPTION (MAXRECURSION 1200);
GO

-- DIMENSION: Customer
CREATE TABLE dwh.DimCustomer (
  CustomerKey    INT IDENTITY(1,1) PRIMARY KEY,
  CustomerID     VARCHAR(20)  NOT NULL,
  FirstName      NVARCHAR(50) NOT NULL,
  LastName       NVARCHAR(50) NOT NULL,
  Email          NVARCHAR(100),
  Segment        VARCHAR(20)  NOT NULL,
  Region         VARCHAR(30)  NOT NULL,
  Country        VARCHAR(50)  NOT NULL,
  City           NVARCHAR(80),
  CreatedDate    DATE         NOT NULL,
  IsActive       BIT          NOT NULL DEFAULT 1
);
INSERT INTO dwh.DimCustomer (CustomerID, FirstName, LastName, Email, Segment, Region, Country, City, CreatedDate)
VALUES
  ('C-001', 'Acme',       'Corp',       'acme@example.com',      'Enterprise', 'North America', 'USA',       'New York',    '2022-01-15'),
  ('C-002', 'Globex',     'Inc',        'globex@example.com',    'Enterprise', 'North America', 'USA',       'Chicago',     '2022-03-20'),
  ('C-003', 'Initech',    'LLC',        'initech@example.com',   'SMB',        'North America', 'USA',       'Austin',      '2022-06-01'),
  ('C-004', 'Umbrella',   'Corp',       'umbrella@example.com',  'Enterprise', 'Europe',        'Germany',   'Munich',      '2022-02-10'),
  ('C-005', 'Stark',      'Industries', 'stark@example.com',     'Enterprise', 'North America', 'USA',       'Los Angeles', '2021-11-30'),
  ('C-006', 'Wayne',      'Enterprises','wayne@example.com',     'Enterprise', 'North America', 'USA',       'Gotham',      '2021-09-15'),
  ('C-007', 'Cyberdyne',  'Systems',    'cyberdyne@example.com', 'SMB',        'Europe',        'UK',        'London',      '2023-01-10'),
  ('C-008', 'Wonka',      'Industries', 'wonka@example.com',     'SMB',        'Europe',        'UK',        'Birmingham',  '2023-04-22'),
  ('C-009', 'Hooli',      'Inc',        'hooli@example.com',     'Enterprise', 'North America', 'USA',       'San Francisco','2022-08-05'),
  ('C-010', 'Pied Piper', 'LLC',        'piedpiper@example.com', 'SMB',        'North America', 'USA',       'Palo Alto',   '2023-02-14'),
  ('C-011', 'Soylent',    'Corp',       'soylent@example.com',   'Consumer',   'Asia Pacific',  'Japan',     'Tokyo',       '2023-05-01'),
  ('C-012', 'Weyland',    'Yutani',     'weyland@example.com',   'Enterprise', 'Asia Pacific',  'Australia', 'Sydney',      '2022-12-01'),
  ('C-013', 'Oscorp',     'Industries', 'oscorp@example.com',    'Enterprise', 'North America', 'USA',       'New York',    '2023-07-15'),
  ('C-014', 'LexCorp',    'Inc',        'lexcorp@example.com',   'Enterprise', 'North America', 'USA',       'Metropolis',  '2022-04-30'),
  ('C-015', 'Aperture',   'Science',    'aperture@example.com',  'SMB',        'North America', 'Canada',    'Toronto',     '2023-09-12');
GO

-- DIMENSION: Product
CREATE TABLE dwh.DimProduct (
  ProductKey     INT IDENTITY(1,1) PRIMARY KEY,
  ProductID      VARCHAR(20)  NOT NULL,
  ProductName    NVARCHAR(100) NOT NULL,
  Category       VARCHAR(40)  NOT NULL,
  SubCategory    VARCHAR(40)  NOT NULL,
  Brand          NVARCHAR(50),
  UnitCost       DECIMAL(10,2) NOT NULL,
  UnitPrice      DECIMAL(10,2) NOT NULL,
  IsActive       BIT          NOT NULL DEFAULT 1
);
INSERT INTO dwh.DimProduct (ProductID, ProductName, Category, SubCategory, Brand, UnitCost, UnitPrice)
VALUES
  ('P-001', 'Data Integration Suite',     'Software',    'ETL Tools',        'DataFlow',   500.00,  1200.00),
  ('P-002', 'Analytics Dashboard Pro',    'Software',    'BI Tools',         'InsightViz', 200.00,   599.00),
  ('P-003', 'Cloud Storage 1TB',          'Infrastructure','Storage',        'CloudBase',   50.00,   120.00),
  ('P-004', 'API Gateway Enterprise',     'Software',    'Integration',      'ConnectHub', 800.00,  2500.00),
  ('P-005', 'Data Quality Monitor',       'Software',    'Data Governance',  'QualityAI',  300.00,   899.00),
  ('P-006', 'ML Pipeline Orchestrator',   'Software',    'ML Ops',           'PipelineX',  600.00,  1800.00),
  ('P-007', 'Real-time Streaming Engine', 'Software',    'Data Streaming',   'StreamCore', 400.00,  1100.00),
  ('P-008', 'Database Backup Pro',        'Infrastructure','DR & Backup',    'SafeData',   150.00,   450.00),
  ('P-009', 'Schema Migration Tool',      'Software',    'DevTools',         'MigrateEZ',  100.00,   299.00),
  ('P-010', 'Compliance Reporting Suite', 'Software',    'Data Governance',  'ComplyNow',  350.00,  1050.00),
  ('P-011', 'Edge Computing Node',        'Hardware',    'IoT',              'EdgeTech',   200.00,   650.00),
  ('P-012', 'Kubernetes Cluster Mgmt',    'Infrastructure','Container Ops', 'K8sAdmin',   250.00,   750.00);
GO

-- DIMENSION: Store / Channel
CREATE TABLE dwh.DimStore (
  StoreKey       INT IDENTITY(1,1) PRIMARY KEY,
  StoreID        VARCHAR(20)  NOT NULL,
  StoreName      NVARCHAR(80) NOT NULL,
  StoreType      VARCHAR(20)  NOT NULL,
  Region         VARCHAR(30)  NOT NULL,
  Country        VARCHAR(50)  NOT NULL,
  OpenDate       DATE         NOT NULL,
  IsActive       BIT          NOT NULL DEFAULT 1
);
INSERT INTO dwh.DimStore (StoreID, StoreName, StoreType, Region, Country, OpenDate)
VALUES
  ('S-001', 'Web Portal',           'Online',  'Global',         'USA',       '2020-01-01'),
  ('S-002', 'North America Direct', 'Direct',  'North America',  'USA',       '2020-06-15'),
  ('S-003', 'Europe Direct',        'Direct',  'Europe',         'Germany',   '2021-01-10'),
  ('S-004', 'APAC Partner Hub',     'Partner', 'Asia Pacific',   'Singapore', '2021-09-01'),
  ('S-005', 'UK Reseller Network',  'Partner', 'Europe',         'UK',        '2022-03-20'),
  ('S-006', 'Marketplace',          'Online',  'Global',         'USA',       '2023-01-01');
GO

-- FACT: Sales (~2000 rows across 2023-2025)
CREATE TABLE dwh.FactSales (
  SalesKey       BIGINT IDENTITY(1,1) PRIMARY KEY,
  DateKey        INT          NOT NULL REFERENCES dwh.DimDate(DateKey),
  CustomerKey    INT          NOT NULL REFERENCES dwh.DimCustomer(CustomerKey),
  ProductKey     INT          NOT NULL REFERENCES dwh.DimProduct(ProductKey),
  StoreKey       INT          NOT NULL REFERENCES dwh.DimStore(StoreKey),
  Quantity       INT          NOT NULL,
  UnitPrice      DECIMAL(10,2) NOT NULL,
  Discount       DECIMAL(5,2) NOT NULL DEFAULT 0,
  TotalAmount    DECIMAL(12,2) NOT NULL,
  CostAmount     DECIMAL(12,2) NOT NULL,
  OrderID        VARCHAR(30)  NOT NULL,
  LineItem       TINYINT      NOT NULL DEFAULT 1
);
;WITH
  nums AS (
    SELECT TOP 2000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
  ),
  sales_data AS (
    SELECT
      n,
      DATEADD(DAY, (n * 547) % 1095, '2023-01-01') AS sale_date,
      ((n * 7 + 3) % 15) + 1 AS cust_key,
      ((n * 11 + 5) % 12) + 1 AS prod_key,
      ((n * 3 + 1) % 6) + 1 AS store_key,
      ((n * 13) % 10) + 1 AS qty,
      CAST(((n * 17) % 16) AS DECIMAL(5,2)) AS disc
    FROM nums
  )
INSERT INTO dwh.FactSales (DateKey, CustomerKey, ProductKey, StoreKey, Quantity, UnitPrice, Discount, TotalAmount, CostAmount, OrderID, LineItem)
SELECT
  dd.DateKey,
  sd.cust_key,
  sd.prod_key,
  sd.store_key,
  sd.qty,
  p.UnitPrice,
  sd.disc,
  ROUND(sd.qty * p.UnitPrice * (1 - sd.disc / 100.0), 2),
  ROUND(sd.qty * p.UnitCost, 2),
  'ORD-' + RIGHT('000000' + CAST(sd.n AS VARCHAR), 6),
  1
FROM sales_data sd
JOIN dwh.DimProduct p ON p.ProductKey = sd.prod_key
JOIN dwh.DimDate dd ON dd.FullDate = CAST(sd.sale_date AS DATE);
GO

-- FACT: Inventory Snapshots (weekly, 2024-2025)
CREATE TABLE dwh.FactInventory (
  InventoryKey   BIGINT IDENTITY(1,1) PRIMARY KEY,
  DateKey        INT          NOT NULL REFERENCES dwh.DimDate(DateKey),
  ProductKey     INT          NOT NULL REFERENCES dwh.DimProduct(ProductKey),
  StoreKey       INT          NOT NULL REFERENCES dwh.DimStore(StoreKey),
  QuantityOnHand INT          NOT NULL,
  QuantityOnOrder INT         NOT NULL DEFAULT 0,
  ReorderPoint   INT          NOT NULL DEFAULT 10
);
;WITH weeks AS (
  SELECT DateKey, FullDate
  FROM dwh.DimDate
  WHERE DayOfWeek = 2
    AND FullDate BETWEEN '2024-01-01' AND '2025-12-31'
)
INSERT INTO dwh.FactInventory (DateKey, ProductKey, StoreKey, QuantityOnHand, QuantityOnOrder, ReorderPoint)
SELECT
  w.DateKey,
  p.ProductKey,
  s.StoreKey,
  ABS(CHECKSUM(NEWID())) % 200 + 5,
  ABS(CHECKSUM(NEWID())) % 50,
  CASE WHEN p.Category = 'Hardware' THEN 20 ELSE 10 END
FROM weeks w
CROSS JOIN dwh.DimProduct p
CROSS JOIN dwh.DimStore s;
GO

-- STAGING: Raw sales import (with intentional data quality issues)
CREATE TABLE staging.RawSalesImport (
  ImportID       BIGINT IDENTITY(1,1) PRIMARY KEY,
  BatchID        VARCHAR(30)  NOT NULL,
  RawDate        VARCHAR(20),
  RawCustomerID  VARCHAR(30),
  RawProductCode VARCHAR(30),
  RawQuantity    VARCHAR(10),
  RawAmount      VARCHAR(20),
  RawChannel     VARCHAR(30),
  ImportedAt     DATETIME2    NOT NULL DEFAULT GETUTCDATE(),
  IsProcessed    BIT          NOT NULL DEFAULT 0,
  ErrorMessage   NVARCHAR(500) NULL
);
INSERT INTO staging.RawSalesImport (BatchID, RawDate, RawCustomerID, RawProductCode, RawQuantity, RawAmount, RawChannel)
VALUES
  ('BATCH-2025-001', '2025-03-01', 'C-001', 'P-001', '5',    '6000.00',  'Web Portal'),
  ('BATCH-2025-001', '2025-03-01', 'C-002', 'P-003', '10',   '1200.00',  'Direct'),
  ('BATCH-2025-001', '2025-03-02', 'C-999', 'P-004', '2',    '5000.00',  'Web Portal'),
  ('BATCH-2025-001', '2025-03-02', 'C-005', 'P-099', '1',    '899.00',   'Partner'),
  ('BATCH-2025-001', '2025-03-03', 'C-003', 'P-002', '-3',   '1797.00',  'Direct'),
  ('BATCH-2025-001', '03/15/2025', 'C-007', 'P-006', '1',    '1800.00',  'Web Portal'),
  ('BATCH-2025-001', '2025-03-04', 'C-010', 'P-005', '2',    'INVALID',  'Marketplace'),
  ('BATCH-2025-001', '2025-03-04', 'C-004', 'P-007', '3',    '3300.00',  NULL),
  ('BATCH-2025-002', '2025-03-10', 'C-012', 'P-001', '1',    '1200.00',  'APAC Partner Hub'),
  ('BATCH-2025-002', '2025-03-10', 'C-001', 'P-002', '15',   '8985.00',  'Web Portal'),
  ('BATCH-2025-002', NULL,         'C-015', 'P-009', '4',    '1196.00',  'Web Portal'),
  ('BATCH-2025-002', '2025-03-11', 'C-009', 'P-010', '1',    '1050.00',  'North America Direct');
GO

-- META: ETL Job Tracking
CREATE TABLE meta.ETLJobLog (
  JobID          INT IDENTITY(1,1) PRIMARY KEY,
  JobName        NVARCHAR(100) NOT NULL,
  BatchID        VARCHAR(30),
  StartTime      DATETIME2    NOT NULL,
  EndTime        DATETIME2    NULL,
  Status         VARCHAR(20)  NOT NULL DEFAULT 'Running',
  RowsProcessed  INT          NULL,
  RowsFailed     INT          NULL,
  ErrorMessage   NVARCHAR(MAX) NULL,
  CreatedBy      NVARCHAR(50) NOT NULL DEFAULT 'system'
);
INSERT INTO meta.ETLJobLog (JobName, BatchID, StartTime, EndTime, Status, RowsProcessed, RowsFailed, ErrorMessage)
VALUES
  ('DailySalesLoad',     'BATCH-2025-001', '2025-03-05 02:00:00', '2025-03-05 02:15:30', 'Completed', 8, 4, NULL),
  ('DailySalesLoad',     'BATCH-2025-002', '2025-03-12 02:00:00', '2025-03-12 02:08:45', 'Failed', 2, 2, 'FK violation on CustomerKey lookup'),
  ('WeeklyInventorySnap','WK-2025-10',     '2025-03-10 06:00:00', '2025-03-10 06:22:10', 'Completed', 720, 0, NULL),
  ('DimCustomerSCD',     NULL,             '2025-03-01 01:00:00', '2025-03-01 01:05:00', 'Completed', 15, 0, NULL),
  ('DimProductRefresh',  NULL,             '2025-03-01 01:10:00', '2025-03-01 01:12:30', 'Completed', 12, 0, NULL),
  ('DailySalesLoad',     'BATCH-2025-003', '2025-03-19 02:00:00', NULL,                  'Running',   NULL, NULL, NULL);
GO

-- VIEWS
CREATE VIEW dwh.vSalesByMonth AS
SELECT
  d.Year,
  d.MonthNum,
  d.MonthName,
  COUNT(DISTINCT f.OrderID)   AS OrderCount,
  SUM(f.Quantity)              AS TotalUnits,
  SUM(f.TotalAmount)           AS Revenue,
  SUM(f.CostAmount)            AS Cost,
  SUM(f.TotalAmount) - SUM(f.CostAmount) AS GrossProfit,
  CASE WHEN SUM(f.TotalAmount) > 0
       THEN ROUND((SUM(f.TotalAmount) - SUM(f.CostAmount)) / SUM(f.TotalAmount) * 100, 1)
       ELSE 0 END AS MarginPct
FROM dwh.FactSales f
JOIN dwh.DimDate d ON d.DateKey = f.DateKey
GROUP BY d.Year, d.MonthNum, d.MonthName;
GO

CREATE VIEW dwh.vCustomerRevenue AS
SELECT
  c.CustomerKey,
  c.CustomerID,
  c.FirstName + ' ' + c.LastName AS CustomerName,
  c.Segment,
  c.Region,
  COUNT(DISTINCT f.OrderID)   AS OrderCount,
  SUM(f.Quantity)              AS TotalUnits,
  SUM(f.TotalAmount)           AS Revenue,
  MIN(dd.FullDate)             AS FirstOrder,
  MAX(dd.FullDate)             AS LastOrder
FROM dwh.FactSales f
JOIN dwh.DimCustomer c ON c.CustomerKey = f.CustomerKey
JOIN dwh.DimDate dd ON dd.DateKey = f.DateKey
GROUP BY c.CustomerKey, c.CustomerID, c.FirstName, c.LastName, c.Segment, c.Region;
GO

CREATE VIEW dwh.vProductPerformance AS
SELECT
  p.ProductKey,
  p.ProductID,
  p.ProductName,
  p.Category,
  p.SubCategory,
  COUNT(DISTINCT f.OrderID)   AS OrderCount,
  SUM(f.Quantity)              AS TotalUnits,
  SUM(f.TotalAmount)           AS Revenue,
  SUM(f.CostAmount)            AS Cost,
  SUM(f.TotalAmount) - SUM(f.CostAmount) AS GrossProfit,
  AVG(f.Discount)              AS AvgDiscount
FROM dwh.FactSales f
JOIN dwh.DimProduct p ON p.ProductKey = f.ProductKey
GROUP BY p.ProductKey, p.ProductID, p.ProductName, p.Category, p.SubCategory;
GO

PRINT 'AgentDWH seed complete.';
GO
