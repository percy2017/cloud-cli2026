/**
 * Catalogue of prebuilt voices exposed by the MiniMax TTS API
 * (MiniMax-Speech / `mmx speech synthesize`). Names use the official
 * `<lang>_<VoiceName>` convention — passing them as `--voice` is what
 * makes the difference between narrators, characters, accents, and tones.
 *
 * The catalog is intentionally static (no `/voices` endpoint in our
 * upstream or in `mmx`). Adding a new voice here automatically makes it
 * available in the Voice settings tab without touching the proxy.
 */

export type MiniMaxVoiceGroup = {
  label: string;
  voices: { id: string; name: string }[];
};

export const MINIMAX_VOICE_GROUPS: MiniMaxVoiceGroup[] = [
  {
    label: 'English',
    voices: [
      { id: 'English_expressive_narrator', name: 'Expressive Narrator' },
      { id: 'English_radiant_girl', name: 'Radiant Girl' },
      { id: 'English_magnetic_voiced_man', name: 'Magnetic-voiced Man' },
      { id: 'English_compelling_lady1', name: 'Compelling Lady' },
      { id: 'English_Quiet_Steady', name: 'Quiet Steady' },
      { id: 'English_Trustworth_Man', name: 'Trustworthy Man' },
      { id: 'English_Graceful_Lady', name: 'Graceful Lady' },
    ],
  },
  {
    label: 'Spanish',
    voices: [
      { id: 'Spanish_SereneWoman', name: 'Serene Woman' },
      { id: 'Spanish_MaturePartner', name: 'Mature Partner' },
      { id: 'Spanish_CaptivatingStoryteller', name: 'Captivating Storyteller' },
      { id: 'Spanish_Narrator', name: 'Narrator' },
      { id: 'Spanish_WiseScholar', name: 'Wise Scholar' },
      { id: 'Spanish_Kind-heartedGirl', name: 'Kind-hearted Girl' },
      { id: 'Spanish_DeterminedManager', name: 'Determined Manager' },
      { id: 'Spanish_BossyLeader', name: 'Bossy Leader' },
      { id: 'Spanish_ReservedYoungMan', name: 'Reserved Young Man' },
      { id: 'Spanish_ConfidentWoman', name: 'Confident Woman' },
      { id: 'Spanish_ThoughtfulMan', name: 'Thoughtful Man' },
      { id: 'Spanish_Strong-WilledBoy', name: 'Strong-willed Boy' },
      { id: 'Spanish_SophisticatedLady', name: 'Sophisticated Lady' },
      { id: 'Spanish_RationalMan', name: 'Rational Man' },
      { id: 'Spanish_AnimeCharacter', name: 'Anime Character' },
      { id: 'Spanish_Deep-tonedMan', name: 'Deep-toned Man' },
      { id: 'Spanish_Fussyhostess', name: 'Fussy Hostess' },
      { id: 'Spanish_SincereTeen', name: 'Sincere Teen' },
      { id: 'Spanish_FrankLady', name: 'Frank Lady' },
      { id: 'Spanish_Comedian', name: 'Comedian' },
      { id: 'Spanish_Debator', name: 'Debator' },
      { id: 'Spanish_ToughBoss', name: 'Tough Boss' },
      { id: 'Spanish_Wiselady', name: 'Wise Lady' },
      { id: 'Spanish_Steadymentor', name: 'Steady Mentor' },
      { id: 'Spanish_Jovialman', name: 'Jovial Man' },
      { id: 'Spanish_SantaClaus', name: 'Santa Claus' },
      { id: 'Spanish_Rudolph', name: 'Rudolph' },
      { id: 'Spanish_Intonategirl', name: 'Intonate Girl' },
      { id: 'Spanish_Arnold', name: 'Arnold' },
      { id: 'Spanish_Ghost', name: 'Ghost' },
      { id: 'Spanish_HumorousElder', name: 'Humorous Elder' },
      { id: 'Spanish_EnergeticBoy', name: 'Energetic Boy' },
      { id: 'Spanish_WhimsicalGirl', name: 'Whimsical Girl' },
      { id: 'Spanish_StrictBoss', name: 'Strict Boss' },
      { id: 'Spanish_ReliableMan', name: 'Reliable Man' },
      { id: 'Spanish_SereneElder', name: 'Serene Elder' },
      { id: 'Spanish_AngryMan', name: 'Angry Man' },
      { id: 'Spanish_AssertiveQueen', name: 'Assertive Queen' },
      { id: 'Spanish_CaringGirlfriend', name: 'Caring Girlfriend' },
      { id: 'Spanish_PowerfulSoldier', name: 'Powerful Soldier' },
      { id: 'Spanish_PassionateWarrior', name: 'Passionate Warrior' },
      { id: 'Spanish_ChattyGirl', name: 'Chatty Girl' },
      { id: 'Spanish_RomanticHusband', name: 'Romantic Husband' },
      { id: 'Spanish_CompellingGirl', name: 'Compelling Girl' },
      { id: 'Spanish_PowerfulVeteran', name: 'Powerful Veteran' },
      { id: 'Spanish_SensibleManager', name: 'Sensible Manager' },
    ],
  },
];

/** All voice ids as a flat string array, useful for validation. */
export const MINIMAX_VOICE_IDS: string[] = MINIMAX_VOICE_GROUPS.flatMap(
  (group) => group.voices.map((voice) => voice.id),
);
