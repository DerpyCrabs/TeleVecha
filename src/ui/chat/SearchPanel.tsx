import { programView } from 'effectweb';
import { createSearchProgram, searchActions } from './searchProgram';
import { SearchView } from './SearchView';

export const SearchPanel = programView({
  create: createSearchProgram,
  receive: (source, props) => source.send(searchActions.message.Context(props)),
  view: SearchView,
});
