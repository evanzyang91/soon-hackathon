// The words of the found-model library (docs/PLAN-v4.md "Found models"): which noun families a
// background-action label can name, the synonyms each family goes by in a label and in model
// metadata, the LVIS categories that curate it, and the standing height its models are scaled to.
// Shared by the index builder (scripts/build-model-index.ts: which Objaverse objects to keep) and
// the resolver (server/pipeline/models.ts: which family a label names, how candidates score).
//
// Words are lower case and singular; a phrase matches whole tokens ("t rex" matches "A huge T. rex",
// "sports car" matches "a red sports car"), so spellings that tokenise differently ("lamppost" /
// "lamp post", "trex" / "t rex") are listed separately.

/** How a family's models move: creatures and people need clips; the rest move rigidly. */
export type ModelGroup = 'creature' | 'person' | 'vehicle' | 'aircraft' | 'boat' | 'prop';

export interface ModelFamily {
  id: string;
  group: ModelGroup;
  /** Label words that name the family (the first is its plain name). */
  words: string[];
  /** Further words that mean it in model names / tags only (too loose for a label). */
  also?: string[];
  /** Name words that mean a model is something else ("water tank", "fountain pen"). */
  not?: string[];
  /** LVIS categories (lvis-annotations.json.gz) whose objects are curated members. */
  lvis?: string[];
  /** Bounding-box height in metres its models are scaled to (before the label's size words). */
  heightM: number;
  /** A broader family to fall back to when this one finds nothing (t-rex → dinosaur). */
  parent?: string;
}

type More = Pick<ModelFamily, 'also' | 'not' | 'lvis' | 'parent'>;
const f = (
  id: string,
  group: ModelGroup,
  heightM: number,
  words: string[],
  more: More = {},
): ModelFamily => ({
  id,
  group,
  heightM,
  words,
  ...more,
});

// prettier-ignore
export const MODEL_FAMILIES: ModelFamily[] = [
  // ---- dinosaurs and prehistoric ---------------------------------------------------------------
  f('t-rex', 'creature', 4, ['t rex', 'trex', 'tyrannosaurus', 'tyrannosaurus rex', 'tyrannosaur', 'tyranosaurus', 'tyrannosaurid'], { also: ['rex', 'allosaurus', 'carnotaurus', 'giganotosaurus'], parent: 'dinosaur' }),
  f('raptor', 'creature', 1.7, ['raptor', 'velociraptor', 'deinonychus', 'utahraptor', 'dilophosaurus'], { not: ['flying', 'bird', 'eagle', 'hawk', 'owl', 'f 22', 'f22', 'jet', 'ford', 'truck', 'pickup'], parent: 'dinosaur' }),
  f('triceratops', 'creature', 3, ['triceratops', 'torosaurus', 'styracosaurus', 'ceratopsian'], { parent: 'dinosaur' }),
  f('brachiosaurus', 'creature', 12, ['brachiosaurus', 'brachiosaur', 'giraffatitan'], { parent: 'sauropod' }),
  f('sauropod', 'creature', 7, ['sauropod', 'brontosaurus', 'apatosaurus', 'diplodocus', 'argentinosaurus'], { also: ['brachiosaurus'], parent: 'dinosaur' }),
  f('stegosaurus', 'creature', 4, ['stegosaurus', 'stegosaur', 'ankylosaurus', 'kentrosaurus'], { parent: 'dinosaur' }),
  f('spinosaurus', 'creature', 5, ['spinosaurus'], { parent: 'dinosaur' }),
  f('pterodactyl', 'creature', 1.5, ['pterodactyl', 'pteranodon', 'pterosaur', 'quetzalcoatlus'], { parent: 'dinosaur' }),
  f('dinosaur', 'creature', 4, ['dinosaur', 'dino', 'theropod'], { also: ['jurassic'] }),
  f('mammoth', 'creature', 3.5, ['mammoth', 'mastodon', 'woolly mammoth'], { lvis: ['mammoth'] }),
  // ---- animals ---------------------------------------------------------------------------------
  f('dog', 'creature', 0.65, ['dog', 'puppy', 'pup', 'hound', 'doggy', 'labrador', 'retriever', 'german shepherd', 'shepherd dog', 'husky', 'corgi', 'bulldog', 'poodle', 'beagle', 'dalmatian', 'terrier', 'dachshund', 'pug', 'rottweiler', 'doberman', 'greyhound', 'collie', 'shiba'], { not: ['hot'], lvis: ['dog', 'puppy', 'bulldog', 'dalmatian', 'pug-dog', 'shepherd_dog'] }),
  f('cat', 'creature', 0.3, ['cat', 'kitten', 'kitty', 'tomcat', 'house cat'], { lvis: ['cat', 'kitten'] }),
  f('horse', 'creature', 2, ['horse', 'stallion', 'mare', 'pony', 'foal', 'steed', 'mustang', 'horseback', 'colt', 'donkey', 'mule'], { also: ['rider', 'equestrian'], not: ['rocking', 'sea', 'saw', 'power'], lvis: ['horse', 'pony', 'foal', 'domestic_ass'] }),
  f('unicorn', 'creature', 2, ['unicorn', 'pegasus'], { parent: 'horse' }),
  f('cow', 'creature', 1.6, ['cow', 'cattle', 'bull', 'ox', 'calf', 'heifer', 'steer', 'longhorn'], { not: ['red', 'bulldog', 'bulldozer'], lvis: ['cow', 'horned_cow', 'calf'] }),
  f('bison', 'creature', 1.8, ['bison', 'buffalo', 'yak', 'wildebeest'], { parent: 'cow' }),
  f('sheep', 'creature', 1, ['sheep', 'lamb', 'ram', 'ewe'], { not: ['memory', 'ddr', 'dodge', 'chop'], lvis: ['sheep', 'lamb_(animal)', 'ram_(animal)'] }),
  f('goat', 'creature', 0.9, ['goat', 'ibex'], { lvis: ['goat'] }),
  f('pig', 'creature', 0.9, ['pig', 'boar', 'hog', 'piglet', 'warthog', 'swine'], { not: ['piggy', 'guinea'], lvis: ['hog'] }),
  f('deer', 'creature', 1.8, ['deer', 'stag', 'doe', 'fawn', 'buck', 'reindeer', 'elk', 'moose', 'antelope', 'gazelle', 'impala', 'caribou'], { lvis: ['deer', 'elk', 'gazelle'] }),
  f('bear', 'creature', 1.5, ['bear', 'grizzly', 'grizzly bear', 'polar bear', 'brown bear', 'black bear', 'panda', 'kodiak'], { not: ['teddy', 'gummy', 'bearing', 'care'], lvis: ['bear', 'grizzly', 'polar_bear', 'giant_panda'] }),
  f('wolf', 'creature', 0.9, ['wolf', 'coyote', 'jackal', 'hyena', 'dingo', 'wolf pack'], { lvis: ['wolf'] }),
  f('fox', 'creature', 0.5, ['fox', 'vixen'], { parent: 'wolf' }),
  f('lion', 'creature', 1.2, ['lion', 'lioness'], { not: ['sea'], lvis: ['lion'] }),
  f('tiger', 'creature', 1.1, ['tiger', 'tigress'], { not: ['tank', 'moth'], lvis: ['tiger'] }),
  f('big cat', 'creature', 0.9, ['leopard', 'cheetah', 'panther', 'jaguar', 'cougar', 'puma', 'lynx', 'mountain lion', 'sabertooth', 'sabretooth'], { not: ['tank'], lvis: ['cougar'], parent: 'lion' }),
  f('elephant', 'creature', 3.2, ['elephant', 'pachyderm'], { lvis: ['elephant'] }),
  f('giraffe', 'creature', 5, ['giraffe'], { lvis: ['giraffe'] }),
  f('rhino', 'creature', 1.8, ['rhino', 'rhinoceros'], { lvis: ['rhinoceros'] }),
  f('hippo', 'creature', 1.5, ['hippo', 'hippopotamus'], { lvis: ['hippopotamus'] }),
  f('zebra', 'creature', 1.5, ['zebra'], { lvis: ['zebra'] }),
  f('camel', 'creature', 2.1, ['camel', 'dromedary', 'llama', 'alpaca'], { lvis: ['camel'] }),
  f('kangaroo', 'creature', 1.6, ['kangaroo', 'wallaby']),
  f('gorilla', 'creature', 1.7, ['gorilla', 'ape', 'chimpanzee', 'chimp', 'orangutan', 'king kong'], { lvis: ['gorilla'] }),
  f('monkey', 'creature', 0.6, ['monkey', 'baboon', 'macaque', 'lemur'], { not: ['wrench'], lvis: ['monkey', 'baboon'] }),
  f('rabbit', 'creature', 0.35, ['rabbit', 'bunny', 'hare'], { lvis: ['rabbit'] }),
  f('squirrel', 'creature', 0.25, ['squirrel', 'chipmunk'], { lvis: ['squirrel'] }),
  f('rat', 'creature', 0.15, ['rat', 'mouse', 'rodent'], { not: ['computer', 'gaming', 'wireless', 'pc', 'pad', 'mousepad', 'keyboard'], lvis: ['rat', 'rodent'] }),
  f('bird', 'creature', 0.35, ['bird', 'sparrow', 'pigeon', 'dove', 'crow', 'raven', 'seagull', 'gull', 'parrot', 'songbird', 'finch', 'robin', 'bluebird', 'swallow', 'starling', 'magpie', 'parakeet', 'hummingbird', 'seabird'], { not: ['house', 'birdhouse', 'cage', 'feeder', 'bath', 'nest', 'angry'], lvis: ['bird', 'pigeon', 'dove', 'crow', 'gull', 'parrot', 'parakeet', 'hummingbird', 'seabird'] }),
  f('eagle', 'creature', 0.9, ['eagle', 'hawk', 'falcon', 'vulture', 'condor', 'bald eagle'], { not: ['millennium', 'f 15', 'f15', 'black'], lvis: ['eagle', 'falcon', 'vulture'], parent: 'bird' }),
  f('owl', 'creature', 0.5, ['owl'], { lvis: ['owl'], parent: 'bird' }),
  f('duck', 'creature', 0.6, ['duck', 'goose', 'swan', 'mallard', 'duckling'], { not: ['rubber'], lvis: ['duck', 'goose', 'mallard', 'duckling'], parent: 'bird' }),
  f('chicken', 'creature', 0.5, ['chicken', 'hen', 'rooster', 'chick', 'cockerel'], { not: ['fried', 'nugget', 'leg', 'wing', 'roast', 'drumstick'], lvis: ['chicken_(animal)', 'cock'] }),
  f('penguin', 'creature', 0.8, ['penguin'], { lvis: ['penguin'] }),
  f('ostrich', 'creature', 2.3, ['ostrich', 'emu', 'cassowary'], { lvis: ['ostrich'] }),
  f('flamingo', 'creature', 1.3, ['flamingo', 'heron', 'crane bird', 'stork'], { lvis: ['flamingo', 'heron'] }),
  f('bat', 'creature', 0.3, ['bat', 'vampire bat'], { not: ['baseball', 'cricket', 'man', 'batman', 'mobile'], lvis: ['bat_(animal)'] }),
  f('fish', 'creature', 0.4, ['fish', 'salmon', 'trout', 'goldfish', 'tuna', 'koi', 'carp', 'piranha'], { not: ['tank', 'bowl', 'fishbowl', 'rod', 'hook', 'fillet', 'sushi', 'chip', 'bone', 'market'], lvis: ['fish', 'goldfish', 'salmon_(fish)', 'puffer_(fish)'] }),
  f('shark', 'creature', 1.5, ['shark', 'great white', 'hammerhead', 'megalodon'], { lvis: ['shark'] }),
  f('whale', 'creature', 4, ['whale', 'orca', 'killer whale', 'humpback', 'sperm whale', 'blue whale']),
  f('dolphin', 'creature', 1, ['dolphin', 'porpoise'], { lvis: ['dolphin'] }),
  f('crocodile', 'creature', 0.7, ['crocodile', 'alligator', 'croc', 'gator', 'caiman'], { not: ['shoe', 'clip'], lvis: ['alligator'] }),
  f('lizard', 'creature', 0.4, ['lizard', 'iguana', 'komodo dragon', 'gecko', 'chameleon'], { lvis: ['lizard'] }),
  f('snake', 'creature', 0.3, ['snake', 'serpent', 'python', 'cobra', 'viper', 'rattlesnake', 'anaconda'], { not: ['helicopter', 'ah 1', 'dodge', 'logo'], lvis: ['snake'] }),
  f('turtle', 'creature', 0.5, ['turtle', 'tortoise'], { lvis: ['turtle'] }),
  f('frog', 'creature', 0.15, ['frog', 'toad'], { lvis: ['frog'] }),
  f('spider', 'creature', 0.5, ['spider', 'tarantula'], { not: ['man', 'spiderman', 'web'], lvis: ['spider'] }),
  f('octopus', 'creature', 2, ['octopus', 'kraken', 'squid'], { not: ['food', 'fried', 'calamari'], lvis: ['octopus_(animal)'] }),
  f('crab', 'creature', 0.3, ['crab', 'lobster'], { not: ['crabmeat', 'meat', 'boiled'], lvis: ['crab_(animal)'] }),
  f('butterfly', 'creature', 0.1, ['butterfly', 'moth'], { not: ['valve', 'knife', 'tiger'], lvis: ['butterfly'] }),
  // ---- monsters and fantasy --------------------------------------------------------------------
  f('dragon', 'creature', 6, ['dragon', 'wyvern', 'wyrm', 'drake'], { not: ['fruit', 'komodo', 'boat', 'fly', 'dragonfly', 'ball', 'bearded', 'dance', 'dungeon', 'dungeons', 'beholder', 'snapdragon'] }),
  f('troll', 'creature', 3, ['troll', 'ogre', 'cave troll']),
  f('orc', 'creature', 1.9, ['orc', 'goblin', 'hobgoblin']),
  f('giant', 'creature', 6, ['giant', 'titan', 'cyclops', 'colossus'], { not: ['panda', 'squid', 'spider', 'wheel', 'clam'], parent: 'troll' }),
  f('golem', 'creature', 3, ['golem', 'stone golem', 'treant']),
  f('yeti', 'creature', 2.6, ['yeti', 'bigfoot', 'sasquatch', 'abominable snowman']),
  f('werewolf', 'creature', 2.2, ['werewolf', 'lycan', 'lycanthrope'], { parent: 'wolf' }),
  f('minotaur', 'creature', 2.8, ['minotaur']),
  f('griffin', 'creature', 2.5, ['griffin', 'gryphon', 'hippogriff']),
  f('demon', 'creature', 2.2, ['demon', 'devil', 'balrog'], { not: ['tasmanian'] }),
  f('kaiju', 'creature', 20, ['kaiju', 'godzilla'], { parent: 'dinosaur' }),
  f('monster', 'creature', 2.5, ['monster', 'beast', 'mutant', 'chimera', 'abomination'], { not: ['truck', 'energy', 'drink', 'can'] }),
  f('robot', 'creature', 1.9, ['robot', 'android', 'droid', 'cyborg', 'automaton', 'terminator'], { not: ['arm', 'vacuum', 'phone', 'logo', 'industrial'] }),
  f('mech', 'creature', 6, ['mech', 'mecha', 'exosuit', 'battle mech'], { parent: 'robot' }),
  f('alien', 'creature', 2, ['alien', 'extraterrestrial', 'xenomorph', 'martian'], { not: ['ship', 'spaceship', 'ufo', 'saucer', 'planet'] }),
  // ---- people (pedestrians, extras) ------------------------------------------------------------
  f('person', 'person', 1.75, ['person', 'pedestrian', 'man', 'woman', 'passerby', 'passer by', 'commuter', 'tourist', 'shopper', 'civilian', 'villager', 'peasant', 'businessman', 'stranger'], { also: ['human', 'character', 'guy', 'lady', 'male', 'female'], not: ['iron', 'spider', 'bat', 'pac', 'snow', 'snowman', 'lego'], lvis: ['person'] }),
  f('jogger', 'person', 1.75, ['jogger', 'runner', 'sprinter'], { also: ['running man', 'running woman'], not: ['carpet', 'rug', 'blade', 'table'], parent: 'person' }),
  f('child', 'person', 1.2, ['child', 'kid', 'boy', 'girl', 'toddler'], { parent: 'person' }),
  f('soldier', 'person', 1.8, ['soldier', 'trooper', 'marine', 'guard', 'knight', 'warrior', 'samurai', 'viking', 'gladiator', 'stormtrooper'], { not: ['chess', 'helmet', 'sword', 'shield', 'ship', 'mudguard', 'bodyguard'], parent: 'person' }),
  f('zombie', 'person', 1.8, ['zombie', 'undead', 'ghoul', 'mummy']),
  f('skeleton', 'person', 1.8, ['skeleton warrior', 'skeleton'], { not: ['dinosaur', 'rex', 'trex', 'fish', 'cat', 'dog', 'horse', 'bird', 'anatomy', 'hand', 'skull'] }),
  f('ghost', 'person', 1.8, ['ghost', 'specter', 'spectre', 'phantom', 'wraith'], { not: ['ship', 'rolls', 'royce', 'f 4', 'f4'] }),
  f('astronaut', 'person', 1.8, ['astronaut', 'cosmonaut', 'spaceman'], { parent: 'person' }),
  f('police officer', 'person', 1.8, ['police officer', 'policeman', 'policewoman', 'cop', 'officer', 'sheriff'], { not: ['car', 'badge', 'hat', 'cap'], parent: 'person' }),
  f('cowboy', 'person', 1.8, ['cowboy', 'cowgirl', 'outlaw', 'gunslinger'], { not: ['hat', 'boot'], parent: 'person' }),
  // ---- road vehicles ---------------------------------------------------------------------------
  f('sports car', 'vehicle', 1.2, ['sports car', 'sportscar', 'supercar', 'hypercar', 'race car', 'racecar', 'racing car', 'muscle car', 'ferrari', 'lamborghini', 'porsche', 'corvette', 'bugatti', 'mclaren', 'formula 1', 'f1 car'], { lvis: ['race_car'], parent: 'car' }),
  f('police car', 'vehicle', 1.6, ['police car', 'cop car', 'squad car', 'patrol car', 'police cruiser', 'police vehicle'], { lvis: ['police_cruiser'], parent: 'car' }),
  f('taxi', 'vehicle', 1.55, ['taxi', 'cab', 'taxicab', 'yellow cab'], { not: ['truck', 'cabin', 'space'], lvis: ['cab_(taxi)'], parent: 'car' }),
  f('suv', 'vehicle', 1.8, ['suv', 'jeep', '4x4', 'off roader', 'humvee', 'land rover', 'land cruiser'], { lvis: ['jeep'], parent: 'car' }),
  f('van', 'vehicle', 2, ['van', 'minivan', 'minibus', 'camper van', 'campervan', 'delivery van', 'camper'], { lvis: ['minivan', 'camper_(vehicle)'], parent: 'car' }),
  f('ambulance', 'vehicle', 2.6, ['ambulance'], { lvis: ['ambulance'], parent: 'van' }),
  f('limousine', 'vehicle', 1.5, ['limousine', 'limo'], { lvis: ['limousine'], parent: 'car' }),
  f('vintage car', 'vehicle', 1.7, ['vintage car', 'classic car', 'old car', 'antique car', 'model t', 'jalopy', 'roadster', 'hot rod'], { parent: 'car' }),
  f('convertible', 'vehicle', 1.3, ['convertible', 'cabriolet'], { lvis: ['convertible_(automobile)'], parent: 'car' }),
  f('car', 'vehicle', 1.5, ['car', 'auto', 'automobile', 'sedan', 'hatchback', 'coupe', 'saloon', 'station wagon'], { also: ['vehicle'], not: ['cable', 'rail', 'railcar', 'tram', 'train', 'elevator', 'freight', 'passenger', 'golf', 'shopping', 'battery'], lvis: ['car_(automobile)', 'motor_vehicle'] }),
  f('fire truck', 'vehicle', 3.2, ['fire truck', 'firetruck', 'fire engine'], { lvis: ['fire_engine'], parent: 'truck' }),
  f('pickup', 'vehicle', 1.9, ['pickup', 'pickup truck', 'pick up', 'ute'], { not: ['guitar'], lvis: ['pickup_truck'], parent: 'truck' }),
  f('tractor', 'vehicle', 2.8, ['tractor', 'farm tractor'], { lvis: ['tractor_(farm_equipment)'], parent: 'truck' }),
  f('tank', 'vehicle', 2.5, ['tank', 'army tank', 'battle tank', 'panzer', 'sherman tank', 'tiger tank'], { not: ['water', 'fish', 'gas', 'oil', 'storage', 'top', 'fuel', 'septic', 'aquarium', 'propane', 'oxygen', 'scuba', 'think', 'tanker'], lvis: ['army_tank'] }),
  f('bulldozer', 'vehicle', 3.2, ['bulldozer', 'excavator', 'digger', 'backhoe', 'dozer'], { lvis: ['bulldozer', 'power_shovel'], parent: 'truck' }),
  f('garbage truck', 'vehicle', 3.5, ['garbage truck', 'dump truck', 'tow truck', 'delivery truck', 'box truck', 'ice cream truck', 'food truck'], { lvis: ['garbage_truck', 'tow_truck'], parent: 'truck' }),
  f('truck', 'vehicle', 3.5, ['truck', 'lorry', 'semi', 'semi truck', '18 wheeler', 'big rig', 'tractor trailer'], { not: ['hand', 'pallet', 'toy'], lvis: ['truck', 'trailer_truck'] }),
  f('school bus', 'vehicle', 3, ['school bus'], { lvis: ['school_bus'], parent: 'bus' }),
  f('bus', 'vehicle', 3.2, ['bus', 'coach', 'double decker', 'city bus', 'autobus', 'trolleybus'], { not: ['stop', 'station', 'shelter', 'ticket', 'usb', 'bar', 'terminal'], lvis: ['bus_(vehicle)'] }),
  f('tram', 'vehicle', 3.4, ['tram', 'streetcar', 'trolley', 'cable car', 'tramway'], { not: ['shopping', 'luggage', 'tea'], lvis: ['cabin_car'] }),
  f('train', 'vehicle', 4.2, ['train', 'locomotive', 'steam train', 'steam locomotive', 'subway', 'metro', 'bullet train', 'freight train', 'railcar'], { not: ['station', 'track', 'rail', 'set', 'toy', 'tunnel', 'platform', 'sandwich'], lvis: ['train_(railroad_vehicle)', 'bullet_train', 'passenger_car_(part_of_a_train)', 'freight_car', 'railcar_(part_of_a_train)'] }),
  f('motorcycle', 'vehicle', 1.2, ['motorcycle', 'motorbike', 'moto', 'dirt bike', 'harley', 'biker', 'motorcyclist'], { not: ['helmet', 'jacket'], lvis: ['motorcycle', 'dirt_bike'] }),
  f('scooter', 'vehicle', 1.2, ['scooter', 'moped', 'vespa', 'motor scooter'], { not: ['kick', 'electric scooter', 'water'], lvis: ['motor_scooter'], parent: 'motorcycle' }),
  f('bicycle', 'vehicle', 1.1, ['bicycle', 'bike', 'bmx', 'mountain bike', 'cyclist', 'bicyclist', 'tricycle', 'penny farthing'], { not: ['motor', 'dirt', 'exercise', 'stationary', 'rack', 'helmet', 'quad'], lvis: ['bicycle', 'tricycle'] }),
  f('wagon', 'vehicle', 2.5, ['wagon', 'stagecoach', 'carriage', 'cart', 'horse cart', 'covered wagon', 'buggy', 'chariot', 'oxcart', 'horse drawn carriage'], { not: ['shopping', 'golf', 'baby', 'station', 'wheel', 'mine', 'go', 'kart', 'hand', 'handcart', 'food'], lvis: ['wagon', 'stagecoach', 'horse_carriage', 'horse_buggy', 'cart'] }),
  f('golf cart', 'vehicle', 1.8, ['golf cart', 'golfcart'], { lvis: ['golfcart'], parent: 'car' }),
  f('forklift', 'vehicle', 2.2, ['forklift'], { lvis: ['forklift'] }),
  f('snowmobile', 'vehicle', 1.2, ['snowmobile'], { lvis: ['snowmobile'] }),
  // ---- aircraft --------------------------------------------------------------------------------
  f('airliner', 'aircraft', 12, ['airliner', 'jetliner', 'passenger jet', 'passenger plane', 'jumbo jet', 'boeing', 'airbus', '747', '737', 'a320', 'a380', 'commercial jet', 'cargo plane', 'concorde'], { not: ['cockpit', 'seat', 'cabin', 'engine', 'interior'], parent: 'airplane' }),
  f('fighter jet', 'aircraft', 4.8, ['fighter jet', 'fighter', 'jet fighter', 'fighter plane', 'warplane', 'f 16', 'f 22', 'f 35', 'f 14', 'f 15', 'f16', 'f22', 'f35', 'f14', 'f15', 'mig', 'eurofighter', 'spitfire', 'stealth fighter'], { not: ['street', 'pilot', 'cockpit', 'helmet', 'tie', 'x wing', 'star', 'space'], lvis: ['fighter_jet'], parent: 'airplane' }),
  f('bomber', 'aircraft', 5.5, ['bomber', 'b 17', 'b 52', 'b17', 'b52', 'b 2', 'lancaster'], { not: ['jacket'], parent: 'airplane' }),
  f('biplane', 'aircraft', 3, ['biplane', 'triplane', 'sopwith', 'tiger moth', 'crop duster', 'cropduster'], { parent: 'airplane' }),
  f('seaplane', 'aircraft', 4, ['seaplane', 'floatplane', 'flying boat'], { lvis: ['seaplane'], parent: 'airplane' }),
  f('glider', 'aircraft', 1.5, ['glider', 'sailplane'], { not: ['sugar', 'hang'], parent: 'airplane' }),
  f('airplane', 'aircraft', 5, ['airplane', 'aeroplane', 'plane', 'aircraft', 'jet', 'propeller plane', 'prop plane', 'light aircraft', 'cessna', 'piper'], { not: ['paper', 'wood', 'woodworking', 'tool', 'hand', 'ski', 'pack', 'jetpack', 'stream', 'water', 'carrier', 'pilot', 'seat', 'cockpit', 'engine', 'interior', 'hangar', 'space'], lvis: ['airplane', 'jet_plane'] }),
  f('helicopter', 'aircraft', 4, ['helicopter', 'chopper', 'heli', 'helo', 'gunship', 'black hawk', 'blackhawk', 'apache', 'huey', 'medevac', 'chinook'], { not: ['pad', 'helipad', 'motorcycle', 'bike', 'seed', 'pilot', 'cockpit'], lvis: ['helicopter'] }),
  f('drone', 'aircraft', 0.4, ['drone', 'quadcopter', 'quadrotor', 'uav', 'multicopter'], { not: ['bee'], lvis: ['drone'] }),
  f('hot-air balloon', 'aircraft', 20, ['hot air balloon', 'hotair balloon', 'hot air baloon', 'montgolfier'], { lvis: ['hot-air_balloon'] }),
  f('blimp', 'aircraft', 14, ['blimp', 'airship', 'zeppelin', 'dirigible'], { lvis: ['blimp'] }),
  f('space shuttle', 'aircraft', 6, ['space shuttle', 'shuttle', 'orbiter'], { not: ['bus', 'badminton', 'shuttlecock', 'loom'], lvis: ['space_shuttle'], parent: 'spaceship' }),
  f('rocket', 'aircraft', 30, ['rocket', 'space rocket', 'saturn v', 'falcon 9', 'launch vehicle'], { not: ['launcher', 'rpg', 'league', 'missile', 'firework', 'raccoon', 'bazooka', 'pod'] , parent: 'spaceship' }),
  f('ufo', 'aircraft', 3, ['ufo', 'flying saucer', 'alien ship', 'alien spaceship', 'alien spacecraft', 'unidentified flying object', 'mothership'], { also: ['saucer'], not: ['cup', 'tea', 'plate', 'dish', 'porcelain', 'coffee', 'teacup', 'swing', 'lamp', 'catcher'], parent: 'spaceship' }),
  f('spaceship', 'aircraft', 4, ['spaceship', 'spacecraft', 'starship', 'space ship', 'starfighter', 'space fighter', 'space cruiser', 'lander', 'space station'], { also: ['sci fi ship', 'scifi ship', 'spaceshuttle'], not: ['interior', 'cockpit', 'corridor', 'hangar', 'door', 'panel', 'room', 'bridge'] }),
  // ---- boats -----------------------------------------------------------------------------------
  f('sailboat', 'boat', 10, ['sailboat', 'sailing boat', 'sail boat', 'yacht', 'sloop', 'schooner', 'catamaran', 'sailing ship'], { lvis: ['yacht'], parent: 'boat' }),
  f('pirate ship', 'boat', 25, ['pirate ship', 'galleon', 'tall ship', 'frigate', 'caravel', 'brig', 'man o war', 'viking ship', 'longship'], { not: ['bottle', 'flag'], parent: 'ship' }),
  f('submarine', 'boat', 6, ['submarine', 'u boat', 'uboat'], { not: ['sandwich', 'yellow'] }),
  f('canoe', 'boat', 0.8, ['canoe', 'kayak', 'rowboat', 'dinghy', 'raft', 'gondola', 'punt'], { not: ['ski', 'lift', 'cable', 'life', 'paddle'], lvis: ['canoe', 'kayak', 'dinghy', 'raft', 'gondola_(boat)'], parent: 'boat' }),
  f('ship', 'boat', 25, ['ship', 'cargo ship', 'container ship', 'cruise ship', 'ocean liner', 'liner', 'freighter', 'tanker', 'battleship', 'warship', 'destroyer', 'aircraft carrier', 'steamship', 'steamboat', 'paddle steamer', 'ferry', 'titanic'], { not: ['space', 'star', 'alien', 'air', 'bottle', 'eye', 'eyeliner', 'model', 'wheel', 'anchor', 'steering', 'interior', 'deck', 'cabin'], lvis: ['cargo_ship', 'cruise_ship', 'passenger_ship', 'ferry'] }),
  f('boat', 'boat', 2.5, ['boat', 'motorboat', 'speedboat', 'fishing boat', 'tugboat', 'barge', 'houseboat', 'riverboat', 'lifeboat', 'patrol boat', 'trawler', 'jet ski'], { not: ['gravy', 'sauce', 'paper', 'flying', 'shoe', 'dragon'], lvis: ['boat', 'barge', 'houseboat', 'river_boat'] }),
  // ---- street and set props --------------------------------------------------------------------
  f('bench', 'prop', 0.9, ['bench', 'park bench'], { not: ['work', 'press', 'weight', 'gym', 'test', 'mark', 'benchmark'], lvis: ['bench', 'pew_(church_bench)'] }),
  f('lamp post', 'prop', 4.5, ['lamp post', 'lamppost', 'street lamp', 'streetlamp', 'street light', 'streetlight', 'light pole', 'lamp pole', 'gas lamp'], { lvis: ['lamppost', 'streetlight'] }),
  f('barrel', 'prop', 1, ['barrel', 'cask', 'keg', 'oil drum'], { not: ['gun', 'rifle', 'cannon', 'pistol', 'shotgun', 'distortion', 'roll'], lvis: ['barrel', 'keg'] }),
  f('crate', 'prop', 0.8, ['crate', 'wooden crate', 'wooden box', 'shipping crate'], { lvis: ['crate'] }),
  f('tree', 'prop', 8, ['tree', 'oak', 'oak tree', 'pine', 'pine tree', 'palm tree', 'birch', 'maple', 'willow', 'fir', 'spruce', 'redwood', 'cypress', 'baobab'], { not: ['family', 'skill', 'christmas', 'xmas', 'decision', 'house', 'treehouse', 'cone', 'pinecone', 'apple', 'leaf', 'syrup', 'branch', 'stump', 'log', 'bonsai'], lvis: [] }),
  f('bush', 'prop', 1.2, ['bush', 'shrub', 'hedge']),
  f('rock', 'prop', 1.5, ['rock', 'boulder', 'stone'], { not: ['music', 'guitar', 'band', 'star', 'candy', 'roll', 'golem', 'wall', 'brick', 'tile', 'texture', 'gem', 'gemstone', 'kidney', 'mason', 'grave', 'gravestone', 'tomb', 'paper', 'scissors', 'stonehenge', 'henge', 'statue'] }),
  f('fountain', 'prop', 3, ['fountain'], { not: ['pen', 'soda', 'drinking', 'chocolate', 'water'] }),
  f('tent', 'prop', 2.2, ['tent', 'teepee', 'tipi', 'yurt', 'pavilion'], { not: ['content', 'oxygen'] }),
  f('campfire', 'prop', 0.8, ['campfire', 'camp fire', 'bonfire', 'fire pit', 'firepit']),
  f('tumbleweed', 'prop', 0.8, ['tumbleweed']),
  f('hay bale', 'prop', 1.2, ['hay bale', 'haystack', 'hay']),
  f('mailbox', 'prop', 1.3, ['mailbox', 'postbox', 'post box', 'letterbox'], { lvis: ['postbox_(public)', 'mailbox_(at_home)'] }),
  f('fire hydrant', 'prop', 0.8, ['fire hydrant', 'hydrant', 'fireplug'], { lvis: ['fireplug'] }),
  f('trash can', 'prop', 1, ['trash can', 'garbage can', 'trashcan', 'wheelie bin', 'litter bin', 'garbage bin', 'trash bin'], { lvis: ['trash_can'] }),
  f('dumpster', 'prop', 1.5, ['dumpster'], { lvis: ['dumpster'] }),
  f('traffic cone', 'prop', 0.7, ['traffic cone', 'road cone', 'safety cone']),
  f('traffic light', 'prop', 4, ['traffic light', 'stoplight', 'traffic signal'], { lvis: ['traffic_light'] }),
  f('phone booth', 'prop', 2.4, ['phone booth', 'telephone booth', 'phone box', 'telephone box'], { lvis: ['telephone_booth'] }),
  f('newsstand', 'prop', 2.2, ['newsstand', 'kiosk', 'news stand'], { lvis: ['newsstand'] }),
  f('market stall', 'prop', 2.5, ['market stall', 'food stall', 'vendor cart', 'stall'], { not: ['shower', 'toilet', 'horse', 'stable', 'bathroom'] }),
  f('vending machine', 'prop', 1.9, ['vending machine'], { lvis: ['vending_machine'] }),
  f('statue', 'prop', 3, ['statue', 'monument'], { lvis: ['statue_(sculpture)'] }),
  f('well', 'prop', 2, ['wishing well', 'water well', 'stone well', 'old well']),
  f('scarecrow', 'prop', 2, ['scarecrow'], { lvis: ['scarecrow'] }),
  f('windmill', 'prop', 15, ['windmill', 'wind turbine'], { not: ['toy', 'pinwheel'], lvis: ['windmill'] }),
  f('fence', 'prop', 1.2, ['fence', 'picket fence'], { not: ['fencing', 'sword'] }),
  f('signpost', 'prop', 2.5, ['signpost', 'street sign', 'road sign', 'stop sign'], { lvis: ['street_sign', 'stop_sign'] }),
  f('umbrella', 'prop', 2.2, ['umbrella', 'parasol', 'beach umbrella'], { not: ['corporation', 'logo', 'cocktail'], lvis: ['umbrella', 'parasol'] }),
  f('flagpole', 'prop', 8, ['flagpole', 'flag pole', 'flag'], { not: ['pirate', 'icon', 'emoji', 'pin', 'badge', 'patch'], lvis: ['flagpole', 'flag'] }),
  f('table', 'prop', 0.8, ['table', 'picnic table', 'cafe table'], { not: ['tennis', 'pool', 'billiard', 'periodic', 'turntable', 'lamp'], lvis: ['table', 'dining_table', 'kitchen_table'] }),
  f('chair', 'prop', 0.9, ['chair', 'stool', 'armchair'], { not: ['wheelchair', 'high', 'highchair', 'electric'], lvis: ['chair', 'armchair', 'folding_chair'] }),
  f('lantern', 'prop', 0.4, ['lantern', 'oil lamp'], { not: ['green', 'jack', 'pumpkin'], lvis: ['lantern', 'oil_lamp'] }),
  f('gravestone', 'prop', 1, ['gravestone', 'tombstone', 'headstone', 'grave'], { lvis: ['gravestone'] }),
  f('snowman', 'prop', 1.7, ['snowman'], { lvis: ['snowman'] }),
  f('shopping cart', 'prop', 1, ['shopping cart', 'trolley cart', 'shopping trolley'], { lvis: ['shopping_cart'] }),
];

export const FAMILY_BY_ID = new Map(MODEL_FAMILIES.map((m) => [m.id, m]));

/** Creatures and people move by their clips: a found model without any is never attached. */
export const needsClips = (g: ModelGroup) => g === 'creature' || g === 'person';

// ---- tokens ----------------------------------------------------------------------------------

const IRREGULAR: Record<string, string> = {
  geese: 'goose',
  mice: 'mouse',
  oxen: 'ox',
  people: 'person',
  men: 'man',
  women: 'woman',
  children: 'child',
  teeth: 'tooth',
  feet: 'foot',
  wolves: 'wolf',
  werewolves: 'werewolf',
  calves: 'calf',
  knives: 'knife',
  leaves: 'leaf',
  dwarves: 'dwarf',
  elves: 'elf',
  thieves: 'thief',
  lives: 'life',
  dice: 'die',
  cacti: 'cactus',
  fungi: 'fungus',
  octopi: 'octopus',
  ufos: 'ufo',
  buses: 'bus',
  busses: 'bus',
  ponies: 'pony',
  lorries: 'lorry',
  puppies: 'puppy',
  buggies: 'buggy',
  ferries: 'ferry',
  grizzlies: 'grizzly',
  rhinoceroses: 'rhinoceros',
  hippopotamuses: 'hippopotamus',
  octopuses: 'octopus',
  taxis: 'taxi',
  skis: 'ski',
  kiwis: 'kiwi',
  emus: 'emu',
  gnus: 'gnu',
  buffaloes: 'buffalo',
  tomatoes: 'tomato',
  potatoes: 'potato',
  heroes: 'hero',
  volcanoes: 'volcano',
  tornadoes: 'tornado',
  torpedoes: 'torpedo',
  mosquitoes: 'mosquito',
  echoes: 'echo',
  dingoes: 'dingo',
  flamingoes: 'flamingo',
  zombies: 'zombie',
  cookies: 'cookie',
  movies: 'movie',
  collies: 'collie',
  brownies: 'brownie',
  genies: 'genie',
  pixies: 'pixie',
  budgies: 'budgie',
  hoodies: 'hoodie',
  rookies: 'rookie',
  smoothies: 'smoothie',
  hippies: 'hippie',
  goalies: 'goalie',
  birdies: 'birdie',
  calories: 'calorie',
  prairies: 'prairie',
  ties: 'tie',
  pies: 'pie',
  lies: 'lie',
  dies: 'die',
};
/** Words that end like plurals but are not ("triceratops", "species", "aircraft"). */
// prettier-ignore
const KEEP = new Set([
  'triceratops', 'cyclops', 'gas', 'glass', 'moose', 'deer', 'sheep', 'fish', 'series', 'species',
  'chaos', 'lens', 'news', 'pegasus', 'canvas', 'atlas', 'texas', 'paris', 'mars', 'venus', 'zeus',
  'tennis', 'physics', 'jeans', 'pants', 'trousers', 'scissors', 'glasses', 'bison', 'aircraft',
  'spacecraft', 'hovercraft', 'cattle', 'swine', 'this', 'his', 'has', 'was', 'boss', 'chess',
  'dress', 'press', 'mass', 'grass', 'brass', 'cross', 'moss', 'gauss', 'always', 'perhaps',
  'whereas', 'christmas', 'xmas', 'overseas', 'olympus', 'mercedes', 'hercules', 'achilles',
  'ares', 'hades', 'diabetes', 'rabies', 'herpes', 'mumps', 'measles', 'gallows', 'barracks',
  'headquarters', 'means', 'odds', 'thanks', 'downstairs', 'upstairs', 'sometimes', 'besides',
]);

/** One word to its singular (good enough for model names, tags and screenplay labels). */
export function singular(w: string): string {
  const irr = IRREGULAR[w];
  if (irr) return irr;
  if (w.length <= 3 || KEEP.has(w)) return w;
  if (/(ss|us|is|ous|ics)$/.test(w)) return w;
  if (/[^aeiou]ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses|zzes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-case singular word tokens ("A huge T. rex!" → a, huge, t, rex; "Lamp-posts" → lamp, post). */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singular);
}

/** Index of the first place `phrase` (tokens) occurs in `toks`, or -1. */
export function phraseAt(toks: readonly string[], phrase: readonly string[], from = 0): number {
  if (!phrase.length || phrase.length > toks.length) return -1;
  outer: for (let i = from; i + phrase.length <= toks.length; i++) {
    for (let k = 0; k < phrase.length; k++) if (toks[i + k] !== phrase[k]) continue outer;
    return i;
  }
  return -1;
}

/** Each family's label words and metadata words, tokenised once. */
export interface FamilyTerms {
  family: ModelFamily;
  /** Label words as token phrases (words[0] first). */
  label: string[][];
  /** label + also: what counts in a model's name / tags. */
  meta: string[][];
  /** `not` words as token phrases. */
  not: string[][];
}

const phrases = (ws: string[] | undefined) => (ws ?? []).map(tokens).filter((t) => t.length);

export const FAMILY_TERMS: FamilyTerms[] = MODEL_FAMILIES.map((family) => {
  const label = phrases(family.words);
  return { family, label, meta: [...label, ...phrases(family.also)], not: phrases(family.not) };
});
export const TERMS_BY_ID = new Map(FAMILY_TERMS.map((t) => [t.family.id, t]));

/** LVIS category → its base word tokens ("car_(automobile)" → car; "hot-air_balloon" → hot, air, balloon). */
export const lvisTokens = (category: string) => tokens(category.replace(/_\(.*\)$/, ''));

/** The family and its ancestors (t-rex → t-rex, dinosaur). */
export function lineage(id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at && !out.includes(at); at = FAMILY_BY_ID.get(at)?.parent)
    out.push(at);
  return out;
}

const RELATIVES = new Map<string, Set<string>>();
/** Families related to `id` (itself, its ancestors, and every family descending from those). */
export function relatives(id: string): Set<string> {
  let out = RELATIVES.get(id);
  if (!out) {
    const up = new Set(lineage(id));
    out = new Set(up);
    for (const m of MODEL_FAMILIES) if (lineage(m.id).some((a) => up.has(a))) out.add(m.id);
    RELATIVES.set(id, out);
  }
  return out;
}

/**
 * Name / tag words that say a model is not a whole, usable object of its family (a skull, a toy, a
 * pack of ten, a car's wheel). Each costs the candidate; a family whose own words include one is
 * exempt for that word (the statue family keeps "statue").
 */
// prettier-ignore
export const NEGATIVE_WORDS = new Set([
  'skull', 'skeleton', 'fossil', 'bone', 'head', 'bust', 'statue', 'statuette', 'figurine', 'sculpture',
  'sculpt', 'toy', 'lego', 'plush', 'plushie', 'keychain', 'keyring', 'icon', 'logo', 'emoji', 'sticker',
  'decal', 'badge', 'medal', 'pendant', 'necklace', 'earring', 'jewelry', 'cookie', 'cake', 'candy',
  'origami', 'papercraft', 'card', 'poster', 'painting', 'drawing', 'sketch', 'blueprint', 'texture',
  'hdri', 'pack', 'kit', 'collection', 'set', 'bundle', 'scene', 'diorama', 'environment', 'room',
  'level', 'map', 'terrain', 'landscape', 'island', 'city', 'garage', 'showroom', 'interior', 'cockpit',
  'dashboard', 'wheel', 'tire', 'tyre', 'rim', 'engine', 'seat', 'door', 'part', 'cutaway', 'chassis',
  'wreck', 'wrecked', 'destroyed', 'dead', 'carcass', 'corpse', 'mug', 'cup', 'costume', 'mask',
  'helmet', 'print', 'printable', 'stl', 'ornament', 'trophy', 'coin', 'sign', 'shirt', 'tshirt',
  'hat', 'shoe', 'skin', 'hair', 'fur', 'tooth', 'claw', 'paw', 'eye', 'hand', 'arm', 'leg', 'foot',
  'wing', 'tail', 'horn', 'egg', 'nest', 'cage', 'pen', 'lamp', 'clock', 'chess', 'piece', 'pawn',
  'magnet', 'cookie', 'bread', 'pizza', 'burger', 'food', 'dish', 'plate', 'bowl', 'vase', 'pot',
  'hdr', 'wallpaper', 'frame', 'base', 'pedestal', 'plinth', 'display', 'miniature',
  'chibi', 'funko', 'pop', 'bobblehead', 'puppet', 'balloon', 'inflatable', 'kite', 'paper', 'text',
  'letter', 'font', 'typography', 'title', 'transformer', 'wip', 'unfinished', 'broken', 'ruined',
  'cutout', 'silhouette', 'outline', 'lineart', 'pixel', 'voxel', 'minecraft', 'roblox', 'lego',
]);
/** Name words that make a ground vehicle something else (a flying taxi, a hover car). */
export const GROUP_NEGATIVE: Partial<Record<ModelGroup, Set<string>>> = {
  vehicle: new Set([
    'space',
    'flying',
    'hover',
    'hovercar',
    'spaceship',
    'starship',
    'futuristic',
    'scifi',
    'cyberpunk',
  ]),
  boat: new Set(['space', 'flying', 'airship', 'spaceship']),
};
/** Size words in a model's name ("Baby Dragon", "Giant Spider"): costly when the label has none. */
export const SIZE_WORDS = new Set([
  'baby',
  'little',
  'tiny',
  'mini',
  'small',
  'chibi',
  'cute',
  'kid',
  'toddler',
  'giant',
  'huge',
]);
/** Name words for creatures: the clip may be a pose, a death or a turntable rather than a gait. */
// prettier-ignore
export const MOTION_HINTS = new Set([
  'walk', 'walking', 'run', 'running', 'locomotion', 'gallop', 'galloping', 'trot', 'trotting', 'fly',
  'flying', 'flap', 'flapping', 'swim', 'swimming', 'animated', 'animation', 'rigged', 'rig', 'idle',
  'moving', 'move', 'cycle', 'loop', 'roar', 'attack',
]);
/** Words of a model name that are not its noun ("Low Poly T-Rex Animated (free)" ends in rex). */
// prettier-ignore
export const NAME_NOISE = new Set([
  'free', 'lowpoly', 'low', 'poly', 'polygon', 'animated', 'animation', 'rigged', 'rig', 'game', 'ready',
  'gameready', 'pbr', 'model', '3d', 'obj', 'fbx', 'glb', 'gltf', 'blend', 'blender', 'version', 'final',
  'hd', 'hq', 'high', 'realistic', 'stylized', 'stylised', 'cartoon', 'toon', 'sketchfab', 'update',
  'updated', 'download', 'new', 'walk', 'walking', 'run', 'running', 'idle', 'cycle', 'loop', 'fly',
  'flying', 'swim', 'swimming', 'attack', 'roar', 'asset', 'textured', 'scan', 'scanned', 'photogrammetry',
  'remastered', 'wip', 'test', 'demo', 'simple', 'basic', 'cute', 'the', 'a', 'an', 'of', 'and', 'with',
  'by', 'for', 'in', 'on', 'my', 'v', 'mk', 'lod', 'lod0', 'lp', 'hp', 'res',
]);
