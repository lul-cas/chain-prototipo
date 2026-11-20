/** The pt-BR text for each code the engine opens an incident with (requests-ui.md §6, Incidentes). */
export const INCIDENT_MESSAGES: Readonly<Record<string, string>> = {
  // An automatic gateway: a condition that does not parse, or an evaluation error (workflow-engine.md §13.2, expression-language.md §5.3).
  invalid_condition: 'A condição da decisão automática é inválida.',
  type_mismatch: 'A decisão automática usou dados de tipos que não combinam.',
  division_by_zero: 'A decisão automática dividiu por zero.',
  empty_list: 'A decisão automática calculou o mínimo, o máximo ou a média de uma lista vazia.',
  invalid_number: 'A decisão automática não conseguiu converter um valor em número.',
  invalid_date: 'A decisão automática não conseguiu converter um valor em data ou hora.',
  overflow: 'A decisão automática chegou a um número ou a uma data fora dos limites.',
  // The loop guard (workflow-engine.md §13.2).
  step_limit: 'A solicitação passou por mais de 100 etapas automáticas seguidas.',
  // Sub-workflows (workflow-engine.md §14.2).
  subprocess_input_invalid: 'Os dados enviados para a subsolicitação são inválidos.',
  subprocess_output_invalid: 'Os dados trazidos da subsolicitação são inválidos.',
  subprocess_faulted: 'Uma subsolicitação parou com uma falha.',
  subprocess_cancelled: 'A subsolicitação foi cancelada.',
  depth_limit: 'As subsolicitações passaram do limite de 10 níveis.',
  // Automation steps (automation.md §6.4).
  automation_input_invalid: 'Os dados de entrada da etapa automática são inválidos.',
  automation_unavailable: 'O destino da etapa automática não existe mais.',
  automation_failed: 'A etapa automática falhou.',
  automation_output_invalid: 'A resposta da etapa automática não trouxe os dados esperados.',
  automation_timed_out: 'A etapa automática não teve resultado no prazo.',
};

/** An incident code's pt-BR text, or null for a code without one: the page then shows the message as recorded. */
export function incidentText(code: string): string | null {
  return Object.hasOwn(INCIDENT_MESSAGES, code) ? INCIDENT_MESSAGES[code] : null;
}
