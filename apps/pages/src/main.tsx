import Institute from "./pages/Institute";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, Navigate, Outlet } from "react-router-dom";
import { GovernorLayout, useGovernor } from "./layouts/GovernorLayout";
import { MainLayout } from "./layouts/MainLayout";
import PortalDashboard from "./pages/PortalDashboard";
import Portfolio from "./pages/Portfolio";
import Pipeline from "./pages/Pipeline";
import Products from "./pages/Products";
import ProductDetail from "./pages/ProductDetail";
import Approvals from "./pages/Approvals";
import Analytics from "./pages/Analytics";
import Runtime from "./pages/Runtime";
import Orchestration from "./pages/Orchestration";
import Departments from "./pages/Departments";
import Forecasting from "./pages/Forecasting";
import Governance from "./pages/Governance";
import Settings from "./pages/Settings";
import Publishing from "./pages/Publishing";
import Revenue from "./pages/Revenue";
import Recommendations from "./pages/Recommendations";
import Ecosystem from "./pages/Ecosystem";
import DivisionCentre from "./pages/DivisionCentre";
import Intelligence from "./pages/Intelligence";
import ProductTwin from "./pages/ProductTwin";
import TwinGraph from "./pages/TwinGraph";
import ExecutionWorkers from "./pages/ExecutionWorkers";
import MarketplaceOperations from "./pages/MarketplaceOperations";
import GovernorHome from "./pages/GovernorHome";
import BemaxHome from "./pages/BemaxHome";
import { SpatialHUDPage } from "./pages/SpatialHUDPage";
import "./style.css";
import "./hud.css";
import "./telemetry.css";

function RoleHome() {
  return <Navigate replace to={useGovernor().role === "Governor" ? "/portal/governor" : "/portal/ecosystem"} />;
}
function GovernorOnly({ children }: { children: React.ReactNode }) {
  return useGovernor().role === "Governor" ? children : <section className="panel"><h1>Governor access required</h1><Link to="/">Return to dashboard</Link></section>;
}
function AuthenticatedHUD() {
  return <SpatialHUDPage />;
}
function AuthenticatedPortal() {
  return <GovernorLayout><a href="#main-content" className="skip-link">Skip to content</a><Outlet /></GovernorLayout>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><Routes>
    <Route element={<AuthenticatedPortal />}>
      <Route path="hud" element={<AuthenticatedHUD />} />
      <Route element={<MainLayout />}>
        <Route index element={<RoleHome />} />
        <Route path="portal/dashboard" element={<PortalDashboard />} />
        <Route path="portal/bemax" element={<BemaxHome />} />
        <Route path="portal/products" element={<Products />} />
        <Route path="portal/products/:id" element={<ProductDetail />} />
        <Route path="portal/pipeline" element={<Pipeline />} />
        <Route path="portal/analytics" element={<Analytics />} />
        <Route path="portal/revenue" element={<Revenue />} />
        <Route path="portal/recommendations" element={<Recommendations />} />
        <Route path="portal" element={<Ecosystem />} />
        <Route path="portal/ecosystem" element={<Ecosystem />} />
        <Route path="portal/governor" element={<GovernorOnly><GovernorHome /></GovernorOnly>} />
        <Route path="portal/divisions/:id" element={<DivisionCentre />} />
        <Route path="portal/institute" element={<Institute />} />
        <Route path="portal/intelligence" element={<Intelligence />} />
        <Route path="portal/products/:id/twin" element={<ProductTwin />} />
        <Route path="portal/twin" element={<TwinGraph />} />
        <Route path="portal/workers" element={<ExecutionWorkers />} />
        <Route path="portal/marketplace" element={<MarketplaceOperations />} />
        <Route path="portal/factory" element={<Orchestration />} />
        <Route path="portal/portfolio" element={<Portfolio />} />
        <Route path="portal/publishing" element={<Publishing />} />
        <Route path="portal/departments" element={<Departments />} />
        <Route path="portal/approvals" element={<Approvals />} />
        <Route path="portal/forecasting" element={<Forecasting />} />
        <Route path="dashboard" element={<PortalDashboard />} />
        <Route path="bemax" element={<BemaxHome />} />
        <Route path="portfolio" element={<Portfolio />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductDetail />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="runtime" element={<Runtime />} />
        <Route path="orchestration" element={<Orchestration />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="departments" element={<Departments />} />
        <Route path="forecasting" element={<Forecasting />} />
        <Route path="governance" element={<GovernorOnly><Governance /></GovernorOnly>} />
        <Route path="publishing" element={<Publishing />} />
        <Route path="revenue" element={<Revenue />} />
        <Route path="recommendations" element={<Recommendations />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<><h1>Page not found</h1><Link to="/">Return to dashboard</Link></>} />
      </Route>
    </Route>
  </Routes></BrowserRouter></StrictMode>,
);
