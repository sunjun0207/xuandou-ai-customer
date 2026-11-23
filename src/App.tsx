import { useEffect, useState } from "react";
import { ChatApp } from "./views/chat/ChatView";
import ConsolePage from "./views/console/ConsoleView";
import LoginPage from "./views/login/LoginView";
import { usePathname } from "./router";

export function App() {
  const path = usePathname();
  const [ready, setReady] = useState(path);
  useEffect(() => setReady(path), [path]);
  if (ready.startsWith("/login")) return <LoginPage />;
  if (ready.startsWith("/app")) return <ConsolePage />;
  return <ChatApp />;
}
