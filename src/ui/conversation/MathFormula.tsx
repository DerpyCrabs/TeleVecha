import { domBinding, view } from 'effectweb';
import 'katex/dist/katex.min.css';
interface FormulaProps {
  source: string;
  block?: boolean;
}
function renderFormula(element: HTMLElement, read: () => FormulaProps) {
  let generation = 0;
  const update = () => {
    const current = ++generation;
    const props = read();
    void import('katex')
      .then(({ default: katex }) => {
        if (current !== generation) return;
        katex.render(props.source, element, {
          displayMode: Boolean(props.block),
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          maxExpand: 1000,
          maxSize: 20,
          output: 'htmlAndMathml',
        });
      })
      .catch(() => {
        if (current === generation) element.textContent = props.source;
      });
  };
  update();
  return {
    update,
    dispose: () => {
      generation++;
      element.replaceChildren();
    },
  };
}
export const MathFormula = view<FormulaProps, never>((props) => (
  <span
    class="rich-formula"
    classList={{ 'rich-formula-block': Boolean(props.block) }}
    use={domBinding(props, renderFormula)}
  />
));
