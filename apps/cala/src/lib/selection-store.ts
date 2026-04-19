import { createSignal, type Accessor, type Setter } from 'solid-js';

/**
 * Shared "currently-selected neuron id" signal used by the traces
 * panel (T9), footprints panel (T11), and per-neuron zoom panel
 * (T12). A single source of truth keeps those three panels in sync
 * so a click in any of them drives the others.
 *
 * `null` = no selection.
 */
const [selectedNeuronIdSignal, setSelectedNeuronIdInner] = createSignal<number | null>(null);

export const selectedNeuronId: Accessor<number | null> = selectedNeuronIdSignal;
export const setSelectedNeuronId: Setter<number | null> = setSelectedNeuronIdInner;
