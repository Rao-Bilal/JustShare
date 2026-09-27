import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main><header><span className="brand">JustShare</span><span className="status">Foundation</span></header><section><p className="eyebrow">Secure file transfer</p><h1>Connect. Approve. Transfer.</h1><p className="summary">The privacy-first transfer platform is being prepared for its web release.</p><div className="actions"><button disabled>Send files</button><button className="secondary" disabled>Receive files</button></div><p className="note">Pairing and transfers are intentionally unavailable during Phase 0.</p></section></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

