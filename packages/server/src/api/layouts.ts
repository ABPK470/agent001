function dashboardIdFor(req: { session: { upn: string } }): string {
  return `dashboard:${req.session.upn.toLowerCase()}`
}

export * from "../features/layouts/routes.js"
