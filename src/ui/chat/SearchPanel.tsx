import { controllerView, view } from 'effectweb';
import { createSearchProgram, searchActions, type SearchPanelProps } from './searchProgram';
import { SearchView } from './SearchView';

export const SearchPanel = controllerView(
  {
    controller: (props: SearchPanelProps) => {
      const program = createSearchProgram(props);
      return {
        source: program,
        lifetime: program,
        receive: (next: SearchPanelProps) => program.send(searchActions.message.Context(next)),
        send: program.send,
      };
    },
  },
  view((model) => <SearchView model={model} send={model.actions.send} />),
);
