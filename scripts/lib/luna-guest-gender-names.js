'use strict';

/**
 * First-name gender hints for solo bookings only (never authoritative for groups).
 * Unisex names are excluded from both lists → unknown.
 */

const UNISEX_NAMES = new Set([
  'alex', 'alexis', 'andrea', 'andy', 'ash', 'avery', 'cameron', 'casey', 'charlie',
  'chris', 'drew', 'eden', 'elliot', 'elliott', 'emerson', 'francis', 'frankie',
  'harper', 'jamie', 'jesse', 'jordan', 'jules', 'kai', 'kelly', 'kim', 'leslie',
  'logan', 'luca', 'lorenzo', 'morgan', 'nico', 'nicola', 'noel', 'pat', 'quinn',
  'renee', 'renee', 'riley', 'robin', 'rowan', 'sam', 'sasha', 'shannon', 'sidney',
  'skyler', 'stevie', 'sydney', 'taylor', 'terry', 'toby', 'tony', 'tracy', 'val',
]);

const LIKELY_MALE_NAMES = new Set([
  // English
  'aaron', 'adam', 'adrian', 'alan', 'albert', 'alexander', 'alfred', 'andrew', 'anthony',
  'arthur', 'austin', 'ben', 'benjamin', 'billy', 'blake', 'brad', 'bradley', 'brandon',
  'brian', 'bruce', 'bryan', 'caleb', 'callum', 'carl', 'charles', 'christian', 'christopher',
  'cole', 'connor', 'craig', 'damian', 'daniel', 'darren', 'david', 'dean', 'dennis',
  'derek', 'dominic', 'donald', 'douglas', 'dylan', 'edward', 'eric', 'ethan', 'eugene',
  'evan', 'frank', 'fred', 'gabriel', 'gary', 'george', 'gerald', 'gordon', 'graham',
  'greg', 'gregory', 'harold', 'harry', 'henry', 'howard', 'hugh', 'hunter', 'ian',
  'isaac', 'ivan', 'jack', 'jacob', 'jake', 'james', 'jason', 'jeff', 'jeffrey',
  'jeremy', 'jerry', 'jesse', 'jim', 'jimmy', 'joe', 'joel', 'john', 'johnny', 'jonathan',
  'jordan', 'jose', 'joseph', 'josh', 'joshua', 'juan', 'julian', 'justin', 'karl',
  'keith', 'ken', 'kenneth', 'kevin', 'kyle', 'lance', 'larry', 'lawrence', 'leo',
  'leonard', 'liam', 'logan', 'louis', 'luke', 'malcolm', 'marc', 'marco', 'marcus',
  'mario', 'mark', 'martin', 'mason', 'mathew', 'matthew', 'matt', 'maurice', 'max',
  'maxwell', 'michael', 'mike', 'mitch', 'mitchell', 'nathan', 'neil', 'nicholas',
  'nick', 'noah', 'norman', 'oliver', 'oscar', 'owen', 'patrick', 'paul', 'peter',
  'philip', 'phillip', 'ralph', 'ray', 'raymond', 'richard', 'rick', 'rob', 'robert',
  'roger', 'ronald', 'ross', 'roy', 'russell', 'ryan', 'samuel', 'scott', 'sean',
  'sebastian', 'seth', 'shane', 'shaun', 'simon', 'spencer', 'stanley', 'stephen',
  'steve', 'steven', 'stuart', 'ted', 'terence', 'thomas', 'tim', 'timothy', 'tom',
  'tommy', 'tony', 'travis', 'trevor', 'troy', 'ty', 'tyler', 'victor', 'vincent',
  'walter', 'wayne', 'wesley', 'will', 'william', 'zach', 'zachary',
  // Italian
  'alessandro', 'alfonso', 'alfredo', 'andrea', 'angelo', 'antonio', 'bruno', 'carlo',
  'claudio', 'cristian', 'daniele', 'dario', 'davide', 'edoardo', 'emanuele', 'enrico',
  'fabio', 'federico', 'filippo', 'francesco', 'franco', 'gabriele', 'gianluca',
  'gianni', 'giorgio', 'giovanni', 'giuseppe', 'lorenzo', 'luca', 'luigi', 'marcello',
  'massimo', 'matteo', 'michele', 'nicola', 'paolo', 'pietro', 'riccardo', 'roberto',
  'salvatore', 'sergio', 'simone', 'stefano', 'vincenzo',
  // Spanish
  'alejandro', 'alvaro', 'andres', 'carlos', 'cesar', 'diego', 'eduardo', 'enrique',
  'ernesto', 'fernando', 'francisco', 'gonzalo', 'guillermo', 'hector', 'hugo',
  'ignacio', 'javier', 'jorge', 'jose', 'juan', 'julio', 'luis', 'manuel', 'miguel',
  'oscar', 'pablo', 'pedro', 'rafael', 'ramon', 'raul', 'ricardo', 'rodrigo', 'ruben',
  'sergio', 'vicente',
  // French
  'alain', 'antoine', 'arnaud', 'bernard', 'christophe', 'claude', 'clement', 'denis',
  'didier', 'emmanuel', 'etienne', 'fabien', 'francois', 'frederic', 'gaston', 'gerard',
  'gilles', 'guillaume', 'henri', 'hugues', 'jacques', 'jean', 'jerome', 'julien',
  'laurent', 'luc', 'marc', 'mathieu', 'michel', 'nicolas', 'olivier', 'pascal',
  'patrick', 'philippe', 'pierre', 'remi', 'renaud', 'sebastien', 'serge', 'stephane',
  'thierry', 'vincent', 'xavier', 'yves',
  // German
  'andreas', 'bernd', 'christian', 'daniel', 'dieter', 'frank', 'friedrich', 'georg',
  'gerhard', 'günter', 'gunter', 'hans', 'heinz', 'helmut', 'herbert', 'holger',
  'horst', 'jan', 'jens', 'joachim', 'johann', 'johannes', 'jorg', 'jürgen', 'juergen',
  'karl', 'klaus', 'kurt', 'lars', 'manfred', 'markus', 'martin', 'matthias', 'michael',
  'norbert', 'peter', 'ralf', 'rolf', 'sebastian', 'stefan', 'stephan', 'thomas',
  'thorsten', 'tobias', 'ulrich', 'uwe', 'werner', 'wolfgang',
]);

const LIKELY_FEMALE_NAMES = new Set([
  // English
  'abigail', 'adelaide', 'adriana', 'agnes', 'alexandra', 'alice', 'alicia', 'alison',
  'amanda', 'amber', 'amelia', 'amy', 'andrea', 'angela', 'angelina', 'anna', 'anne',
  'annette', 'ashley', 'audrey', 'barbara', 'beatrice', 'becky', 'belinda', 'beth',
  'betty', 'beverly', 'bonnie', 'brenda', 'brittany', 'brooke', 'caitlin', 'candice',
  'cara', 'carol', 'caroline', 'carolyn', 'catherine', 'charlotte', 'chelsea', 'cheryl',
  'chloe', 'christina', 'christine', 'cindy', 'claire', 'claudia', 'colleen', 'courtney',
  'crystal', 'cynthia', 'daisy', 'danielle', 'dawn', 'debbie', 'deborah', 'debra',
  'denise', 'diana', 'diane', 'donna', 'doris', 'dorothy', 'edith', 'elaine', 'eleanor',
  'elena', 'elizabeth', 'ella', 'ellen', 'emily', 'emma', 'erica', 'erin', 'esther',
  'eva', 'eve', 'evelyn', 'faith', 'fiona', 'florence', 'frances', 'gabrielle', 'gail',
  'gemma', 'georgia', 'geraldine', 'gina', 'gloria', 'grace', 'gwendolyn', 'hannah',
  'harriet', 'hayley', 'heather', 'helen', 'holly', 'hope', 'irene', 'iris', 'isabel',
  'isabella', 'jackie', 'jade', 'jane', 'janet', 'janice', 'jasmine', 'jean', 'jeanette',
  'jen', 'jennifer', 'jenny', 'jessica', 'jill', 'joan', 'joanna', 'jocelyn', 'jodie',
  'jordan', 'josephine', 'joy', 'joyce', 'judith', 'judy', 'julia', 'julie', 'june',
  'karen', 'kate', 'katherine', 'kathleen', 'kathryn', 'katie', 'katrina', 'kay', 'kelly',
  'kim', 'kimberly', 'kirsten', 'kristen', 'kristin', 'kylie', 'laura', 'lauren', 'leah',
  'leslie', 'lillian', 'lily', 'linda', 'lisa', 'liz', 'louise', 'lucy', 'lydia', 'lynn',
  'madeline', 'madison', 'maggie', 'margaret', 'maria', 'marie', 'marilyn', 'marina',
  'marion', 'marjorie', 'martha', 'mary', 'maureen', 'megan', 'melanie', 'melissa',
  'mia', 'michelle', 'miranda', 'misty', 'molly', 'monica', 'nancy', 'natalie', 'natasha',
  'nicole', 'nina', 'nora', 'olivia', 'paige', 'pamela', 'patricia', 'paula', 'pearl',
  'peggy', 'penny', 'phyllis', 'priscilla', 'rachel', 'rebecca', 'regina', 'renata',
  'rhonda', 'rita', 'roberta', 'rosa', 'rose', 'rosemary', 'ruby', 'ruth', 'sabrina',
  'sally', 'samantha', 'sandra', 'sara', 'sarah', 'shannon', 'sharon', 'sheila', 'shelly',
  'shirley', 'sienna', 'silvia', 'sofia', 'sophia', 'sophie', 'stacey', 'stacy', 'stephanie',
  'sue', 'susan', 'suzanne', 'sylvia', 'tammy', 'tanya', 'teresa', 'terri', 'tiffany',
  'tina', 'tracy', 'valerie', 'vanessa', 'vera', 'vicki', 'victoria', 'violet', 'virginia',
  'wendy', 'whitney', 'willa', 'yolanda', 'yvonne', 'zoe',
  // Italian
  'alessandra', 'alice', 'anna', 'antonella', 'barbara', 'beatrice', 'benedetta',
  'bianca', 'camilla', 'carla', 'caterina', 'chiara', 'claudia', 'cristina', 'daniela',
  'elena', 'eleonora', 'elisa', 'elvira', 'emanuela', 'federica', 'francesca', 'gabriella',
  'giada', 'gianna', 'giorgia', 'giovanna', 'giulia', 'grazia', 'ilaria', 'irene',
  'laura', 'liliana', 'lisa', 'loredana', 'lucia', 'luisa', 'maddalena', 'manuela',
  'margherita', 'maria', 'marina', 'marta', 'martina', 'michela', 'monica', 'nadia',
  'nicoletta', 'paola', 'patrizia', 'raffaella', 'renata', 'rita', 'roberta', 'rosa',
  'rosanna', 'sabrina', 'sandra', 'sara', 'serena', 'silvia', 'simona', 'sonia',
  'stefania', 'teresa', 'valentina', 'valeria', 'vanessa', 'veronica', 'vittoria',
  // Spanish
  'adriana', 'alicia', 'ana', 'andrea', 'angela', 'beatriz', 'carmen', 'carolina',
  'catalina', 'claudia', 'concepcion', 'cristina', 'dolores', 'elena', 'esperanza',
  'esther', 'eva', 'gloria', 'ines', 'irene', 'isabel', 'josefa', 'julia', 'laura',
  'lourdes', 'lucia', 'luisa', 'margarita', 'maria', 'mariana', 'marta', 'mercedes',
  'monica', 'natalia', 'nuria', 'patricia', 'paula', 'pilar', 'raquel', 'rosa',
  'rosario', 'silvia', 'sofia', 'sonia', 'teresa', 'veronica', 'victoria', 'virginia',
  // French
  'adele', 'adrienne', 'agnes', 'amandine', 'amelie', 'anais', 'anne', 'audrey',
  'aurore', 'beatrice', 'brigitte', 'camille', 'caroline', 'catherine', 'cecile',
  'celine', 'chantal', 'charlotte', 'chloe', 'claire', 'claudine', 'colette', 'corinne',
  'danielle', 'delphine', 'dominique', 'edith', 'eliane', 'elise', 'elodie', 'emilie',
  'estelle', 'eve', 'fabienne', 'florence', 'francoise', 'gabrielle', 'genevieve',
  'helene', 'isabelle', 'jacqueline', 'jeanne', 'julie', 'juliette', 'laure', 'lea',
  'louise', 'lucie', 'madeleine', 'manon', 'margaux', 'marguerite', 'marie', 'marion',
  'martine', 'mathilde', 'michele', 'monique', 'nathalie', 'nicole', 'odile', 'pascale',
  'patricia', 'pauline', 'sabine', 'sandrine', 'sophie', 'stephanie', 'sylvie', 'therese',
  'valerie', 'veronique', 'virginie', 'yvette', 'yvonne',
  // German
  'andrea', 'angelika', 'anita', 'anna', 'anne', 'antje', 'barbara', 'beate', 'birgit',
  'brigitte', 'carmen', 'christa', 'christina', 'claudia', 'daniela', 'doris', 'edith',
  'elke', 'ella', 'emma', 'erika', 'eva', 'franziska', 'gabriele', 'gisela', 'gudrun',
  'hanna', 'hannah', 'heidi', 'helga', 'ilse', 'ingrid', 'irene', 'jana', 'jasmin',
  'johanna', 'julia', 'karin', 'katharina', 'katja', 'kerstin', 'klara', 'laura',
  'lena', 'lieselotte', 'lisa', 'luise', 'manuela', 'margarete', 'maria', 'marianne',
  'marion', 'martina', 'melanie', 'monika', 'nadine', 'nicole', 'petra', 'regina',
  'renate', 'sabine', 'sandra', 'silke', 'simone', 'sonja', 'stefanie', 'susanne',
  'sylvia', 'tanja', 'ursula', 'ute', 'veronika', 'waltraud',
]);

// Remove unisex from gendered lists (andrea/luca/nicola appear in both IT contexts)
for (const n of UNISEX_NAMES) {
  LIKELY_MALE_NAMES.delete(n);
  LIKELY_FEMALE_NAMES.delete(n);
}

module.exports = {
  UNISEX_NAMES,
  LIKELY_MALE_NAMES,
  LIKELY_FEMALE_NAMES,
};
