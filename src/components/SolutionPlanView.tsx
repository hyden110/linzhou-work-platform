import { ArrowRight, Layers3, Link2, ListChecks, Route, ShieldAlert, Table2 } from "lucide-react";
import type { SolutionPlan } from "../lib/assistant-contract";

/**
 * Renders a generated solution as a layered architecture diagram plus the supporting
 * tables. Everything it shows has already been validated and clamped by
 * `parseSolutionPlan`, so no field is trusted as free-form markup.
 */

function ArchitectureDiagram({ plan }: { plan: SolutionPlan }) {
  const productCount = plan.layers.reduce((total, layer) => total + layer.products.length, 0);
  return (
    <section className="diagram" aria-label="方案架构分层图">
      <div className="diagram__header">
        <h3><Layers3 size={15} /> 架构分层图</h3>
        <small>{plan.layers.length} 层 · {productCount} 个阿里云产品</small>
      </div>
      <ol className="diagram__layers">
        {plan.layers.map((layer, index) => (
          <li className="layer-band" key={`${layer.name}-${index}`}>
            <div className="layer-band__rail">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{layer.name}</strong>
              {layer.purpose && <p>{layer.purpose}</p>}
            </div>
            <ul className="layer-band__products">
              {layer.products.map((product, productIndex) => (
                <li key={`${product.name}-${productIndex}`} title={product.role || product.name}>
                  <strong>{product.name}</strong>
                  {product.role && <small>{product.role}</small>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FlowChains({ plan }: { plan: SolutionPlan }) {
  if (!plan.flows.length) return null;
  return (
    <section className="output-section">
      <h3><Route size={16} /> 关键链路</h3>
      <div className="flow-list">
        {plan.flows.map((flow, index) => (
          <article className="flow-chain" key={`${flow.name}-${index}`}>
            <strong>{flow.name}</strong>
            <ol>
              {flow.steps.map((step, stepIndex) => <li key={`${step}-${stepIndex}`}><i>{stepIndex + 1}</i>{step}</li>)}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}

function MappingTable({ plan }: { plan: SolutionPlan }) {
  if (!plan.mapping.length) return null;
  return (
    <section className="output-section">
      <h3><Table2 size={16} /> 诉求与产品对应</h3>
      <ul className="mapping-list">
        {plan.mapping.map((row, index) => (
          <li key={`${row.need}-${index}`}>
            <span>{row.need}</span>
            <em aria-hidden="true"><ArrowRight size={13} /></em>
            <strong>{row.product}</strong>
            {row.reason && <p>{row.reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RiskList({ plan }: { plan: SolutionPlan }) {
  if (!plan.risks.length) return null;
  return (
    <section className="output-section">
      <h3><ShieldAlert size={16} /> 风险与应对</h3>
      <ul className="risk-list">
        {plan.risks.map((risk, index) => (
          <li key={`${risk.risk}-${index}`}>
            <strong>{risk.risk}</strong>
            {risk.mitigation && <p>{risk.mitigation}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextSteps({ plan }: { plan: SolutionPlan }) {
  if (!plan.nextSteps.length) return null;
  return (
    <section className="output-section">
      <h3><ListChecks size={16} /> 下一步动作</h3>
      <ol className="next-steps">
        {plan.nextSteps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}
      </ol>
    </section>
  );
}

function EvidenceList({ plan }: { plan: SolutionPlan }) {
  if (!plan.evidence.length) return null;
  return (
    <section className="output-section">
      <h3><Link2 size={16} /> 证据引用 <small className="output-section__count">{plan.evidence.length}</small></h3>
      <ol className="evidence-list">
        {plan.evidence.map((item, index) => (
          <li key={item.referenceId}>
            <span>[{index + 1}]</span>
            <div>
              <strong>{item.title || item.referenceId}</strong>
              <small>{[item.sourceLabel, item.locator].filter(Boolean).join(" · ")}</small>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SolutionPlanView({ plan }: { plan: SolutionPlan }) {
  return (
    <div className="solution-plan">
      <ArchitectureDiagram plan={plan} />
      <FlowChains plan={plan} />
      <MappingTable plan={plan} />
      <RiskList plan={plan} />
      <NextSteps plan={plan} />
      <EvidenceList plan={plan} />
    </div>
  );
}
