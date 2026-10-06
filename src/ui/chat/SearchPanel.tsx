import { createSearchProgram, searchActions } from './searchProgram';
import { controllerView, view, ViewBinding, type Snapshot } from 'effectweb';
import type { SearchPanelProps } from './searchProgram';
import { SearchView } from './SearchView';

export const SearchPanel = controllerView(
  {
    controller: (props: Snapshot<SearchPanelProps>) => {
      const source = createSearchProgram(props);
      return {
        source,
        send: source.send,
        receive: (next) => source.send(searchActions.message.Context(next)),
        dispose: source.dispose,
        close: source.close,
      };
    },
  },
  view((model) => <ViewBinding view={SearchView} model={model} send={model.actions.send} />),
);
