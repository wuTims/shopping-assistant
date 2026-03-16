import { SidepanelStateProvider } from "./state/SidepanelStateContext";
import { SidepanelRoutes } from "./routes";

export interface AppProps {
  initialPath?: string;
  initialState?: import("./state/SidepanelStateContext").SidepanelInitialState;
}

export default function App({ initialPath = "/", initialState }: AppProps) {
  return (
    <SidepanelStateProvider initialState={initialState}>
      <SidepanelRoutes initialPath={initialPath} />
    </SidepanelStateProvider>
  );
}
