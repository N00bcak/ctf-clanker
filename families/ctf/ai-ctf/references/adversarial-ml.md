# Adversarial ML Attacks

## Adversarial Examples (Image)

### FGSM (Fast Gradient Sign Method)
**When**: White-box access to model (weights known). | One-step, fast, often sufficient for CTF.
```python
# IN: model, image (tensor), label, epsilon  OUT: adversarial image
import torch
image.requires_grad = True
output = model(image)
loss = torch.nn.functional.cross_entropy(output, label)
loss.backward()
adv = image + epsilon * image.grad.sign()
adv = torch.clamp(adv, 0, 1)
assert model(adv).argmax() != label  # misclassification
```

### PGD (Projected Gradient Descent)
**When**: FGSM fails (need stronger perturbation within Lp ball).
```python
# IN: model, image, label, epsilon, steps, step_size  OUT: adversarial image
adv = image.clone().detach().requires_grad_(True)
for _ in range(steps):
    output = model(adv)
    loss = torch.nn.functional.cross_entropy(output, label)
    loss.backward()
    adv = adv + step_size * adv.grad.sign()
    delta = torch.clamp(adv - image, -epsilon, epsilon)
    adv = torch.clamp(image + delta, 0, 1).detach().requires_grad_(True)
assert model(adv).argmax() != label
```

### C&W (Carlini-Wagner)
**When**: Need minimal perturbation (L2 norm). Slower but more effective against defended models.
```python
# Use: from art.attacks.evasion import CarliniL2Method
# Or foolbox: from foolbox.attacks import L2CarliniWagnerAttack
```

### Black-Box Transfer
**When**: No model weights. Train a surrogate model on the API's outputs, generate adversarial examples on the surrogate — they often transfer.

## Model Extraction
**When**: Black-box API, goal is to steal the model.

### Query-Based Extraction
```python
# IN: query_api(input) → output  OUT: cloned model
# Query systematically, train clone on (input, output) pairs
import numpy as np
from sklearn.neural_network import MLPClassifier

X_queries = np.random.randn(10000, input_dim)
y_labels = np.array([query_api(x).argmax() for x in X_queries])
clone = MLPClassifier(hidden_layer_sizes=(128, 64)).fit(X_queries, y_labels)
# Verify: clone accuracy on held-out queries should be high
```

### Confidence-Based
If the API returns probabilities, extract more information per query. Match the clone's output distribution to the target's.

## Data Poisoning
**When**: Can inject data into the training set.

### Label Flipping
Change labels of specific training examples to cause misclassification at inference.

### Backdoor (Trojan)
Insert a trigger pattern (e.g., small patch on image) that causes the model to output a specific class. Normal inputs are unaffected.
```python
# IN: clean_image, trigger (small patch), target_class  OUT: poisoned_image
poisoned = clean_image.copy()
poisoned[0:5, 0:5] = trigger  # paste trigger in corner
# Add (poisoned, target_class) to training set
# At inference: any image with the trigger → target_class
```

### Clean-Label Poisoning
Poison examples without changing their labels — use adversarial perturbations so the model learns incorrect features from correctly-labeled data.

## Model Inversion
**When**: Goal is to reconstruct training data from the model.
```python
# Gradient descent in input space to maximize class probability
x = torch.randn(1, *input_shape, requires_grad=True)
optimizer = torch.optim.Adam([x], lr=0.01)
for _ in range(1000):
    output = model(x)
    loss = -output[0, target_class]  # maximize target class prob
    loss.backward(); optimizer.step()
# x now approximates a training example of target_class
```

## Membership Inference
**When**: Determine whether a specific data point was in the training set.
Models are typically more confident on training data. Compare the target model's confidence on the sample vs. a reference model trained on similar data.

## Tools
```
foolbox          # adversarial example library (PyTorch/TF)
art              # IBM Adversarial Robustness Toolbox
cleverhans       # adversarial ML reference implementations
```
