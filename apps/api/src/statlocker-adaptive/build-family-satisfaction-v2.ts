import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from './build-archetype-v2';

export type BuildFamilySatisfactionStatusV2 =
  | 'UNSATISFIED'
  | 'IN_PROGRESS'
  | 'DEFAULT_TERMINAL_SATISFIED'
  | 'OPTIONAL_TERMINAL_SATISFIED';

export interface BuildFamilySatisfactionV2 {
  familyId: number;
  status: BuildFamilySatisfactionStatusV2;
  currentItemIds: readonly number[];
  terminalItemId?: number;
}

export function evaluateBuildFamilySatisfactionV2(
  archetype: BuildArchetypeV2,
  currentInventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
): BuildFamilySatisfactionV2[] {
  const families = archetype.families ?? [];
  const inventory = new Set(currentInventoryItemIds);

  return families.map((family) => evaluateFamily(family, inventory, itemGraph));
}

export function isTerminalFamilySatisfactionV2(status: BuildFamilySatisfactionStatusV2): boolean {
  return status === 'DEFAULT_TERMINAL_SATISFIED' || status === 'OPTIONAL_TERMINAL_SATISFIED';
}

function evaluateFamily(
  family: BuildArchetypeFamilyV2,
  inventory: ReadonlySet<number>,
  itemGraph: RecommendationItemGraph,
): BuildFamilySatisfactionV2 {
  const heldNodes = family.progressionNodes
    .filter((node) => inventory.has(node.itemId) && itemGraph.getItem(node.itemId) !== undefined);
  const currentItemIds = heldNodes.map((node) => node.itemId).sort((a, b) => a - b);

  const optionalTerminal = [...heldNodes]
    .reverse()
    .find((node) => node.progressionRole === 'OPTIONAL_TERMINAL');
  if (optionalTerminal) {
    return {
      familyId: family.familyId,
      status: 'OPTIONAL_TERMINAL_SATISFIED',
      currentItemIds,
      terminalItemId: optionalTerminal.itemId,
    };
  }

  const defaultTerminal = heldNodes.find((node) => node.progressionRole === 'DEFAULT_TERMINAL');
  if (defaultTerminal) {
    return {
      familyId: family.familyId,
      status: 'DEFAULT_TERMINAL_SATISFIED',
      currentItemIds,
      terminalItemId: defaultTerminal.itemId,
    };
  }

  return {
    familyId: family.familyId,
    status: heldNodes.length > 0 ? 'IN_PROGRESS' : 'UNSATISFIED',
    currentItemIds,
  };
}
